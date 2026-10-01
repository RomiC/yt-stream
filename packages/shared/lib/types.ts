export type RequestHandler = (request: Request, server: Bun.Server<undefined>) => Response | Promise<Response>;
