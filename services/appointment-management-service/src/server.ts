import express, { Express, Request, Response } from 'express';
import cors from 'cors';

export function createServer(serviceName: string = 'readiness-engine'): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/health', (req: Request, res: Response) => {
    res.json({
      service: serviceName,
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
