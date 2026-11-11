import { NextFunction, Request, Response } from "express";

export function normalizeRequestPath(req: Request, _res: Response, next: NextFunction) {
    req.url = req.url.replace(/^\/{2,}/, "/");
    req.originalUrl = req.originalUrl.replace(/^\/{2,}/, "/");
    next();
}
