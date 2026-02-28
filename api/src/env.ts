export type Env = { DB: D1Database; AI: Ai; KV: KVNamespace };
export type Variables = { requestId: string };
export type AppContext = { Bindings: Env; Variables: Variables };
