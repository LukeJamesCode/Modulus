// Tiny method+path router. Each route family is a RouteModule: given a request
// context it either handles the request (returns true) or passes (returns
// false). The server tries each in order and 404s if none claim it.

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
}

export type RouteModule = (ctx: RouteContext) => boolean | Promise<boolean>;

export async function dispatch(
  modules: readonly RouteModule[],
  ctx: RouteContext,
): Promise<boolean> {
  for (const module of modules) {
    if (await module(ctx)) return true;
  }
  return false;
}
