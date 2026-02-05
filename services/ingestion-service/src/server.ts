import express, { Express, Request, Response } from 'express';

export function createServer(serviceName: string = 'ingestion-service'): Express {
  const app = express();

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
