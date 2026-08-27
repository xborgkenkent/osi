export type UrlResult = {
  url: string;
  ok: boolean;
  status_code: number | null;
  accessible: boolean;
  error: string | null;
  response_time_ms: number | null;
  ip_address: string | null;
  open_ports: number[] | null;
  server: string | null;
};

export type UrlRow = {
  url: string;
  result: UrlResult | null;
};

export type StreamStartEvent = {
  type: "start";
  total: number;
};

export type StreamResultEvent = {
  type: "result";
  index: number;
  result: UrlResult;
};

export type StreamDoneEvent = {
  type: "done";
};

export type StreamEvent = StreamStartEvent | StreamResultEvent | StreamDoneEvent;
