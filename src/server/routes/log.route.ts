import { Router, Request, Response } from 'express';
import * as path from 'path';

const router = Router();

const LOG_HTML = path.resolve(__dirname, '../../../public/log.html');

router.get('/log', (_req: Request, res: Response) => {
  res.sendFile(LOG_HTML);
});

export default router;
