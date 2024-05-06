import express, { NextFunction } from 'express';
import { generateMetricsForPrometheus } from '../service/service-metrics';

/**
 *
 * @returns Router configured with service routes.
 */
export default function router(): express.Router {
  const result = express.Router();

  result.get('/liveness', async (req, res, _next: NextFunction): Promise<void> => {
    res.send('OK');
  });

  result.get('/readiness', async (req, res, _next: NextFunction): Promise<void> => {
    res.send('OK');
  });

  result.get('/metrics', generateMetricsForPrometheus);

  return result;
}
