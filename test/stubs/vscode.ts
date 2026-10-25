// Runtime stub for the `vscode` module so host-side helpers can be unit tested.
export const Uri = {
  joinPath: (...parts: Array<string | { path: string }>): { path: string } => ({
    path: parts
      .map((part) => (typeof part === 'string' ? part : part.path))
      .join('/'),
  }),
};

export type Webview = {
  cspSource: string;
  asWebviewUri(uri: unknown): unknown;
};
