import db, { Transaction } from '../../util/db';
import { Logger } from 'winston';
import env from '../../util/env';
import WorkItem, { getNextWorkItem, getNextWorkItems, getWorkItemStatus, updateWorkItemStatuses } from '../../models/work-item';
import { getNextJobIdForUsernameAndService, getNextJobIds, getNextUsernameForWork, incrementRunningAndDecrementReadyCounts, recalculateCounts } from '../../models/user-work';
import { getQueueForUrl, getQueueUrlForService, getWorkSchedulerQueue  } from '../../util/queue/queue-factory';
import { QUERY_CMR_SERVICE_REGEX, calculateQueryCmrLimit, processSchedulerQueue } from './util';
import { WorkItemStatus } from '../../models/work-item-interface';

export type WorkItemData = {
  workItem: WorkItem,
  maxCmrGranules?: number
};

/**
 * Get a work item from the database for the given service ID.
 *
 * @param serviceID - the id of the service to get work for
 * @param reqLogger - a logger instance
 * @returns A work item from the database for the given service ID
 */
export async function getWorkFromDatabase(serviceID: string, reqLogger: Logger): Promise<WorkItemData | null> {
  let result: WorkItemData | null = null;
  try {
    await db.transaction(async (tx) => {
      const username = await getNextUsernameForWork(tx, serviceID as string);
      if (username) {
        const jobID = await getNextJobIdForUsernameAndService(tx, serviceID as string, username);
        if (jobID) {
          const workItem = await getNextWorkItem(tx, serviceID as string, jobID);
          if (workItem) {
            await incrementRunningAndDecrementReadyCounts(tx, jobID, serviceID as string);

            if (workItem && QUERY_CMR_SERVICE_REGEX.test(workItem.serviceID)) {
              const childLogger = reqLogger.child({ workItemId: workItem.id });
              const maxCmrGranules = await calculateQueryCmrLimit(tx, workItem, childLogger);
              reqLogger.debug(`Found work item ${workItem.id} for service ${serviceID} with max CMR granules ${maxCmrGranules}`);
              result = { workItem, maxCmrGranules };
            } else {
              result = { workItem };
            }
          } else {
            reqLogger.warn(`user_work is out of sync for user ${username} and job ${jobID}, could not find ready work item`);
            reqLogger.warn(`recalculating ready and running counts for job ${jobID}`);
            await recalculateCounts(tx, jobID);
          }
        }
      }
    });
  } catch (err) {
    reqLogger.error(`Error getting work from database: ${err.message}`);
  }
  return result;
}

/**
 * Return a randomly shuffled list of the given list.
 * This is an implementation of the Fisher-Yates shuffle algorithm.
 *
 * Because the way we readjust the size of work items to retrieve for processing,
 * only the jobs at the back of the list can take advantage of the free slots left by
 * jobs in front. To avoid the situation where a fixed job list with small jobs
 * at the end preventing us from utilizing the full batch size, we randomly shuffle
 * the jobs in the list before looping through them.
 * This shuffle combined with multiple schedulers running in Harmony makes
 * available work items be retrieved for processing more promptly.
 *
 * @param array - the given list to shuffle
 * @returns The randomly shuffled list of the original list
 */
function shuffleArray<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**
 * Get work items from the database for the given service ID.
 *
 * @param serviceID - the id of the service to get work for
 * @param reqLogger - a logger instance
 * @param batchSize - the maximum number of work items to return
 * @returns work items from the database for the given service ID
 */
export async function getWorkItemsFromDatabase(
  serviceID: string,
  reqLogger: Logger,
  batchSize: number): Promise<WorkItemData[]> {
  const workItems: WorkItemData[] = [];
  try {
    const jobIds = await getNextJobIds(db, serviceID as string, batchSize);
    const shuffledJobIds = shuffleArray(jobIds);
    let remainingNumOfJobs = jobIds.length;
    let remainingBatchSize = batchSize;
    let workSize;

    // Define the inner function outside of the loop
    const processJob = async (tx: Transaction, jobId: string) : Promise<void> => {
      // the work size is readjusted based on work items retrieved from the previous job
      workSize = (remainingNumOfJobs > 0) ? Math.ceil(remainingBatchSize / remainingNumOfJobs) : 1;
      const nextWorkItems = await getNextWorkItems(tx, serviceID as string, jobId, workSize);
      if (nextWorkItems?.length > 0) {
        for (const workItem of nextWorkItems) {
          if (workItem && QUERY_CMR_SERVICE_REGEX.test(workItem.serviceID)) {
            const childLogger = reqLogger.child({ workItemId: workItem.id });
            const maxCmrGranules = await calculateQueryCmrLimit(tx, workItem, childLogger);
            reqLogger.debug(`Found work item ${workItem.id} for service ${serviceID} with max CMR granules ${maxCmrGranules}`);
            workItems.push({ workItem, maxCmrGranules });
          } else {
            workItems.push({ workItem });
          }
        }
        await incrementRunningAndDecrementReadyCounts(tx, jobId, serviceID as string, nextWorkItems.length);
      } else {
        reqLogger.warn(`user_work is out of sync for job ${jobId}, could not find ready work item`);
        reqLogger.warn(`recalculating ready and running counts for job ${jobId}`);
        await recalculateCounts(tx, jobId);
      }

      // Readjust the counts for calculating the next work size
      remainingNumOfJobs -= 1;
      remainingBatchSize -= nextWorkItems ? nextWorkItems.length : 0;
    };

    for (const jobId of shuffledJobIds) {
      await db.transaction(async (tx) => {
        await processJob(tx, jobId);
      });
    }
  } catch (err) {
    reqLogger.error(`Error getting works from database: ${err.message}`);
  }
  return workItems;
}

/**
 *  Put a message on the work scheduler queue asking it to schedule some WorkItems for the given
 *  service
 * @param serviceID - The service ID for which to request work
 */
export async function makeWorkScheduleRequest(serviceID: string): Promise<void> {
  // only do this if we are using service queues
  if (env.useServiceQueues) {
    const schedulerQueue = getWorkSchedulerQueue();
    await schedulerQueue.sendMessage(serviceID);
  }
}

/**
 * Get the next work item for the given service from the queue
 * @param serviceID - The service ID for which to get work
 */
export async function getWorkFromQueue(serviceID: string, reqLogger: Logger): Promise<WorkItemData | null> {
  const queueUrl = getQueueUrlForService(serviceID);
  reqLogger.debug(`Short polling for work from queue ${queueUrl} for service ${serviceID}`);

  const queue = getQueueForUrl(queueUrl);
  if (!queue) {
    throw new Error(`No queue found for URL ${queueUrl}`);
  }

  // get a message from the service queue without using long-polling
  let queueItem = await queue.getMessage(0);
  if (!queueItem) {
    reqLogger.debug(`No work found on queue ${queueUrl} for service ${serviceID} - requesting work from scheduler`);
    // put a message on the scheduler queue asking it to schedule some WorkItems for this service
    await makeWorkScheduleRequest(serviceID);

    // this actually does nothing outside of tests since the scheduler pod will be running
    await processSchedulerQueue(reqLogger);

    // long poll for work before giving up
    reqLogger.debug(`Long polling for work on queue ${queueUrl} for service ${serviceID}`);
    queueItem = await queue.getMessage();
  }

  if (queueItem) {
    // reqLogger.debug(`Found work item ${JSON.stringify(queueItem, null, 2)} on queue ${queueUrl}`);
    reqLogger.debug(`Found work item on queue ${queueUrl}`);
    // normally we would process this before deleting the message, but we instead are relying on
    // our retry mechanism to requeue the message if the worker fails
    await queue.deleteMessage(queueItem.receipt);
    reqLogger.debug(`Deleted work item with receipt ${queueItem.receipt} from queue ${queueUrl}`);
    const item = JSON.parse(queueItem.body) as WorkItemData;
    // make sure the item wasn't canceled and set the status to running
    try {
      await db.transaction(async (tx) => {
        const currentStatus = await getWorkItemStatus(tx, item.workItem.id);
        if (currentStatus === WorkItemStatus.CANCELED) {
          reqLogger.debug(`Work item ${item.workItem.id} was canceled, skipping`);
          return null;
        } else {
          await updateWorkItemStatuses(tx, [item.workItem.id], WorkItemStatus.RUNNING);
        }
      });
      return item;
    } catch (err) {
      reqLogger.error(`Error updating work item status to running: ${err.message}`);
    }
  } else {
    reqLogger.debug(`No work found on queue ${queueUrl} for service ${serviceID}`);
  }

  return null;
}

