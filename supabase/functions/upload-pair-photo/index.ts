import { createUploadHandler } from './handler.ts';

Deno.serve(createUploadHandler({ env: name => Deno.env.get(name), fetch }));
