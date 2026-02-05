import express, { Express, Request, Response } from 'express';

export function createServer(serviceName: string = 'readiness-engine'): Express {
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
