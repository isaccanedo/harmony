import { Response, Request, NextFunction } from 'express';
import { getQueuedOrRunningCountForService } from '../models/user-work';
import db from '../util/db';
import logger from '../util/log';
import { RequestValidationError } from '../util/errors';

/**
 * Express.js handler that returns the number of work items in the 'READY' or 'RUNNING' state for the given serviceID
 *
 * @param req - The request sent by the client
 * @param res - The response to send to the client
 * @param next - The next function in the call chain
 * @returns Resolves when the request is complete
 */
export async function getEligibleWorkItemCountForServiceID(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  const serviceID = req.query.serviceID as string;

  // Return 400 if serviceID not provided in query
  if (!serviceID) {
    const err_message = 'required parameter "serviceID" was not provided';
    next(new RequestValidationError(err_message));
    return;
  }

  try {
    let workItemCount;
    await db.transaction(async (tx) => {
      workItemCount = await getQueuedOrRunningCountForService(tx, serviceID);
    });
    if (!workItemCount) workItemCount = 0;
    logger.debug('Got num_ready_work_items metric.');
    const response = {
      availableWorkItems: workItemCount,
    };
    res.json(response);
  } catch (e) {
    next(e);
  }
}