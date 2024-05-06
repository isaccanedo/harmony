import { Response, Request, NextFunction } from 'express';
import axios from 'axios';
import env from '../util/env';
import { keepAliveAgent } from '../util/axios-clients';
import logger from '../../../harmony/app/util/log';

/**
 * Get prometheus-compatible metric message from harmony backend
 * @param serviceID - The service name (essentially the image name)
 * @returns Promise of prometheus-compatible metric message
 */
async function _getHarmonyMetric(serviceID: string): Promise<string> {
  const timeout = 60_000; // Wait up to one minute for the harmony backend server to respond
  const protocol = env.backendHost === 'harmony' || env.backendHost === 'host.docker.internal' ? 'http' : 'https';
  const workUrl = `${protocol}://${env.backendHost}:${env.backendPort}/service/metrics`;
  const response = await axios
    .get(workUrl, {
      params: { serviceID },
      timeout,
      responseType: 'json',
      httpAgent: keepAliveAgent,
      validateStatus(status) {
        return status === 200;
      },
    });

  const metric_message = `# HELP num_ready_work_items Ready work items count for a harmony task-runner service.
# TYPE num_ready_work_items gauge
num_ready_work_items{service_id="${serviceID}"} ${parseInt(response.data.availableWorkItems) + 1}`;

  return metric_message;
}

// Export for testing
export const exportedForTesting = {
  _getHarmonyMetric,
};

/**
 * Express.js handler that generates the Prometheus compatible metrics for the associated service
 *
 * @param req - The request sent by the client
 * @param res - The response to send to the client
 * @param next - The next function in the call chain
 * @returns Resolves when the request is complete
 */
export async function generateMetricsForPrometheus(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    // Get harmony metric for the present service
    const serviceID = env.harmonyService;
    const metric_message = await _getHarmonyMetric(serviceID);

    // Send response
    res.send(metric_message);
  } catch (e) {
    logger.error('Failed to query harmony backend for service metrics.');
    next(e);
  }
}