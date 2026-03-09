import express, { Application } from 'express';
import logRouter from './routes/log.route';
import { createStreamRouter } from './routes/stream.route';
import { ClientManager } from '../services/clientManager';

export function createApp(clientManager: ClientManager): Application {
  const app = express();

  app.use(express.json());

  // Health check — useful for load balancers and integration tests
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(logRouter);
  app.use(createStreamRouter(clientManager));

  return app;
}
