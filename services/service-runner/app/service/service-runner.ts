import * as k8s from '@kubernetes/client-node';
import stream from 'stream';
import { sanitizeImage } from '@harmony/util/string';
import env from '../util/env';
import logger from '../../../harmony/app/util/log';
import { resolve as resolveUrl } from '../../../harmony/app/util/url';
import { objectStoreForProtocol } from '../../../harmony/app/util/object-store';
import { WorkItemRecord, getStacLocation, getItemLogsLocation } from '../../../harmony/app/models/work-item-interface';
import axios from 'axios';
import { Logger } from 'winston';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const exec = new k8s.Exec(kc);

export interface ServiceResponse {
  batchCatalogs?: string[];
  totalItemsSize?: number;
  outputItemSizes?: number[];
  error?: string;
  hits?: number;
  scrollID?: string;
}

// how long to let a worker run before giving up
const { workerTimeout } = env;

// service exit code for Out Of Memory error
const OOM_EXIT_CODE = '137';

/**
 * A writable stream that is passed to the k8s exec call for the worker container.
 * Captures, logs and stores the logs of the worker container's execution.
 */
export class LogStream extends stream.Writable {

  // logs each chunk received
  streamLogger: Logger;

  // all of the logs (JSON or text) that are written
  // to this stream (gets uploaded to s3)
  logStrArr: (string | object)[] = [];

  /**
   * Build a LogStream instance.
   * @param streamLogger - the logger to log messages with
   */
  constructor(streamLogger = logger) {
    super();
    this.streamLogger = streamLogger;
  }

  /**
   * Write a chunk to the log stream.
   * @param chunk - the chunk received by the stream (likely a Buffer)
   */
  _write(chunk, enc: BufferEncoding, next: (error?: Error | null) => void): void {
    const logStr: string = chunk.toString('utf8');
    this._handleLogString(logStr);
    next();
  }

  /**
   * Parse the log chunk (if JSON), push it to the logs array, and log it.
   * @param logStr - the string to log (could emanate from a text or JSON logger)
   */
  _handleLogString(logStr: string): void {
    try {
      const logObj: object = JSON.parse(logStr);
      this.logStrArr.push(logObj);
      for (const propertyName of ['timestamp', 'level']) {
        if (propertyName in logObj) {
          const upperCasedPropName = propertyName[0].toUpperCase() + propertyName.substring(1);
          logObj[`worker${upperCasedPropName}`] = logObj[propertyName];
          delete logObj[propertyName];
        }
      }
      this.streamLogger.debug({ ...logObj, worker: true });
    } catch (e) {
      if (e instanceof SyntaxError) { // string log
        this.logStrArr.push(logStr);
        this.streamLogger.debug(logStr, { worker: true });
      }
    }
  }
}

/**
 * Get a list of full s3 paths to each STAC catalog found in an S3 directory.
 * @param dir - the s3 directory url where the catalogs are located
 */
async function _getStacCatalogs(dir: string): Promise<string[]> {
  const s3 = objectStoreForProtocol('s3');
  // check to see if there is a batch-catalogs.json file and read it if so
  const batchCatalogsJsonUrl = `${dir}batch-catalogs.json`;
  if (await s3.objectExists(batchCatalogsJsonUrl)) {
    const batchCatalogs = await s3.getObjectJson(batchCatalogsJsonUrl) as string[];
    return batchCatalogs.map(filename => `${dir}${filename}`);
  }

  // otherwise retrieve the keys from the bucket that are of the form catalog*.json,
  // and sort them by index number
  const urls = (await s3.listObjectKeys(dir))
    .filter((fileKey) => fileKey.match(/catalog\d*.json$/))
    .map((fileKey) => `s3://${env.artifactBucket}/${fileKey}`);
  const fileNumRegex = /.*catalog(\d+)\.json$/;
  return urls.sort((a, b) => {
    const aMatches = a.match(fileNumRegex);
    const aNum = aMatches.length > 1 ? Number(aMatches[1]) : 0;
    const bMatches = b.match(fileNumRegex);
    const bNum = bMatches.length > 1 ? Number(bMatches[1]) : 0;
    return aNum - bNum;
  });
}

/**
 * Get the error message based on the given status and default error message.
 *
 * @param status - A kubernetes V1Status
 * @param msg - A default error message
 * @returns An error message for the status
 */
function _getErrorMessageOfStatus(status: k8s.V1Status, msg = 'Unknown error'): string {
  const exitCode = status.details?.causes?.find(i => i.reason === 'ExitCode');
  let errorMsg = null;
  if (exitCode?.message === OOM_EXIT_CODE) {
    errorMsg = 'Service failed due to running out of memory';
  }
  return (errorMsg ? errorMsg : msg);
}

/**
 * Get the error message from error.json (if the backend service provided it)
 * or use the k8s status to generate one. This error message
 * is often used to populate the user-facing job's message and errors fields.
 *
 * @param status - A kubernetes V1Status
 * @param catalogDir - A string path for the outputs directory of the WorkItem
 * (e.g. s3://artifacts/requestId/workItemId/outputs/).
 * @param workItemLogger - Logger for logging messages
 * @returns An error message
 */
async function _getErrorMessage(status: k8s.V1Status, catalogDir: string, workItemLogger: Logger = logger): Promise<string> {
  // expect JSON logs entries
  try {
    const s3 = objectStoreForProtocol('s3');
    const errorFile = resolveUrl(catalogDir, 'error.json');
    if (await s3.objectExists(errorFile)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const logEntry: any = await s3.getObjectJson(errorFile);
      return logEntry.error;
    }
    return _getErrorMessageOfStatus(status);
  } catch (e) {
    workItemLogger.error(`Caught exception: ${e}`);
    workItemLogger.error(`Unable to parse out error from catalog location: ${catalogDir}`);
    return _getErrorMessageOfStatus(status, 'Service terminated without error message');
  }
}

/**
 * Run the query cmr service for a work item pulled from Harmony
  * @param operation - The requested operation
  * @param callback - Function to call with result
  * @param maxCmrGranules - Limits the page of granules in the query-cmr task
  * @param workItemLogger - The logger to use
  */
export async function runQueryCmrFromPull(
  workItem: WorkItemRecord,
  maxCmrGranules?: number,
  workItemLogger = logger,
): Promise<ServiceResponse> {
  workItemLogger.debug(`CALLING WORKER with maxCmrGranules = ${maxCmrGranules}`);
  let response;
  try {
    const { operation, scrollID } = workItem;
    const catalogDir = getStacLocation(workItem);
    response = await axios.post(`http://127.0.0.1:${env.workerPort}/work`,
      {
        outputDir: catalogDir,
        harmonyInput: operation,
        scrollId: scrollID,
        maxCmrGranules,
        workItemId: workItem.id,
      },
      {
        timeout: workerTimeout,
      },
    );
    if (response.status < 300) {
      const batchCatalogs = await _getStacCatalogs(catalogDir);
      const { totalItemsSize, outputItemSizes } = response.data;
      const newScrollID = response.data.scrollID;
      return { batchCatalogs, totalItemsSize, outputItemSizes, scrollID: newScrollID };
    }
  } catch (e) {
    workItemLogger.error(e);
    if (e.response) {
      ({ response } = e);
    }
  }
  let error = response?.data?.description || '';
  if (!error && (response?.status || response?.statusText)) {
    error = `The Query CMR service responded with status ${response.statusText || response.status}.`;
  }
  return { error };
}

/**
 * Write logs from the work item execution to s3
 * @param workItem - the work item that the logs are for
 * @param logs - logs array from the k8s exec call
 */
export async function uploadLogs(workItem: WorkItemRecord, logs: (string | object)[]): Promise<object> {
  let newFileContent;
  const retryMessage = `Start of service execution (retryCount=${workItem.retryCount}, id=${workItem.id})`;
  if (logs.length > 0 && (typeof logs[0] === 'string' || logs[0] instanceof String)) {
    newFileContent = [retryMessage, ...logs];
  } else {
    newFileContent = [{ message: retryMessage }, ...logs];
  }
  const s3 = objectStoreForProtocol('s3');
  const logsLocation = getItemLogsLocation(workItem);
  if (await s3.objectExists(logsLocation)) { // append to existing logs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldFileContent: any = await s3.getObjectJson(logsLocation);
    newFileContent = [...oldFileContent, ...newFileContent];
  }
  return s3.upload(JSON.stringify(newFileContent), logsLocation);
}

/**
 * Run a service for a work item pulled from Harmony
 * @param workItem - The item to be worked on in the service
 * @param workItemLogger - The logger to use
 */
export async function runServiceFromPull(workItem: WorkItemRecord, workItemLogger = logger): Promise<ServiceResponse> {
  try {
    const serviceName = sanitizeImage(env.harmonyService);
    const error = `The ${serviceName} service failed.`;
    const { operation, stacCatalogLocation } = workItem;
    // support invocation args specified with newline separator or space separator
    let commandLine = env.invocationArgs.split('\n');
    if (commandLine.length == 1) {
      commandLine = env.invocationArgs.split(' ');
    }

    const catalogDir = getStacLocation(workItem);
    return await new Promise<ServiceResponse>((resolve) => {
      workItemLogger.debug(`CALLING WORKER for pod ${env.myPodName}`);
      // create a writable stream to capture stdout from the exec call
      // using stdout instead of stderr because the service library seems to log ERROR to stdout
      const stdOut = new LogStream(workItemLogger);
      // timeout if things take too long
      const timeout = setTimeout(async () => {
        resolve({ error: `Worker timed out after ${workerTimeout / 1000.0} seconds` });
      }, workerTimeout);

      exec.exec(
        'harmony',
        env.myPodName,
        'worker',
        [
          ...commandLine,
          '--harmony-action',
          'invoke',
          '--harmony-input',
          `${JSON.stringify(operation)}`,
          '--harmony-sources',
          stacCatalogLocation,
          '--harmony-metadata-dir',
          `${catalogDir}`,
        ],
        stdOut,
        process.stderr as stream.Writable,
        process.stdin as stream.Readable,
        true,
        async (status: k8s.V1Status) => {
          workItemLogger.debug(`SIDECAR STATUS: ${JSON.stringify(status, null, 2)}`);
          try {
            await uploadLogs(workItem, stdOut.logStrArr);
            if (status.status === 'Success') {
              clearTimeout(timeout);
              workItemLogger.debug('Getting STAC catalogs');
              const catalogs = await _getStacCatalogs(catalogDir);
              resolve({ batchCatalogs: catalogs });
            } else {
              clearTimeout(timeout);
              const logErr = await _getErrorMessage(status, catalogDir, workItemLogger);
              const errMsg = `${serviceName}: ${logErr}`;
              resolve({ error: errMsg });
            }
          } catch (e) {
            workItemLogger.error('Unable to upload logs. Caught exception:');
            workItemLogger.error(e);
            resolve({ error });
          }
        },
      ).catch((e) => {
        clearTimeout(timeout);
        workItemLogger.error('Kubernetes client exec caught exception:');
        workItemLogger.error(e);
        resolve({ error });
      });
    });
  } catch (e) {
    workItemLogger.error('runServiceFromPull caught exception:');
    workItemLogger.error(e);
    return { error: 'The service failed.' };
  }
}

export const exportedForTesting = {
  _getStacCatalogs,
  _getErrorMessage,
};
