/**
 * The platform's `BodyInit`, derived from `RequestInit` rather than
 * referenced by name: `@types/node` supplies `Request`/`Response`/
 * `RequestInit` (via undici) but not the standalone `BodyInit`/
 * `RequestRedirect` aliases the DOM lib would, and this package builds
 * without `"DOM"` in `lib`.
 */
export type FetchBody = NonNullable<RequestInit["body"]>;

/** Body payloads a `ClientRequest` can carry, after serialization. */
export type ClientRequestBody =
  string | Uint8Array | ReadableStream<Uint8Array> | FormData | undefined;

/** Everything needed to construct a `ClientRequest`. */
export interface ClientRequestInit {
  method: string;
  url: string;
  headers: Headers;
  body?: ClientRequestBody;
  /** The undecoded payload as handed to `post()`/`put()`/etc. See `data()`. */
  data?: unknown;
  /** Raw `RequestInit` from `withFetchOptions()`, merged last at send time. */
  fetchOptions?: RequestInit & Record<string, unknown>;
}

/**
 * A read-only view of the outgoing request, handed to middleware, stubs,
 * and assertion callbacks. Port of Laravel's
 * `Illuminate\Http\Client\Request`.
 *
 * Immutable: `withHeader()`/`withUrl()`/`withBody()` return a new instance,
 * so a request middleware transforms by returning rather than mutating,
 * and holding one across a retry can't observe a later attempt's changes.
 *
 * Named `ClientRequest` rather than `Request` to avoid shadowing both the
 * platform global and `@mahiframework/http`'s inbound request class.
 */
export class ClientRequest {
  readonly method: string;
  readonly url: string;
  private readonly _headers: Headers;
  private readonly _body: ClientRequestBody;
  private readonly _data: unknown;
  readonly fetchOptions: RequestInit & Record<string, unknown>;

  constructor(init: ClientRequestInit) {
    this.method = init.method.toUpperCase();
    this.url = init.url;
    this._headers = new Headers(init.headers);
    this._body = init.body;
    this._data = init.data;
    this.fetchOptions = init.fetchOptions ?? {};
  }

  /**
   * Every header as a plain record, multi-value headers comma-joined per
   * the `Headers` spec. Names are lowercased, as `Headers` normalises them.
   */
  headers(): Record<string, string> {
    return Object.fromEntries(this._headers.entries());
  }

  /**
   * A single header's value, or `undefined` if absent. Returns a string
   * (comma-joined if multi-valued), never an array, Laravel's
   * `Request::header()` returning an array while `Response::header()`
   * returns a string is a foot-gun this port declines to reproduce.
   */
  header(name: string): string | undefined {
    return this._headers.get(name) ?? undefined;
  }

  /**
   * Whether the header is present, and, if `value` is given, whether it
   * matches exactly. Port of `Request::hasHeader($key, $value)`.
   */
  hasHeader(name: string, value?: string): boolean {
    const actual = this._headers.get(name);

    if (actual === null) {
      return false;
    }

    return value === undefined || actual === value;
  }

  /**
   * The serialized request body as a string. Empty for a body-less request
   * (`GET`), for a `FormData` multipart body (whose serialization is the
   * transport's job, use `hasFile()`/`data()` instead), and for a stream.
   */
  body(): string {
    if (typeof this._body === "string") {
      return this._body;
    }

    if (this._body instanceof Uint8Array) {
      return new TextDecoder().decode(this._body);
    }

    return "";
  }

  /**
   * The decoded payload exactly as passed to `post()`/`put()`/`patch()`,
   * the object, not a re-parsed body string. This is the ergonomic win that
   * `laravel_data` exists to provide in Laravel; keeping it on the request
   * directly beats smuggling it through a transport option.
   *
   *   Http.assertSent((req) => (req.data() as { name: string }).name === "Ada");
   */
  data(): unknown {
    return this._data;
  }

  /** The raw body, for the transport and for multipart inspection. */
  rawBody(): ClientRequestBody {
    return this._body;
  }

  isJson(): boolean {
    return this._headers.get("content-type")?.includes("/json") ?? false;
  }

  isForm(): boolean {
    return (
      this._headers.get("content-type")?.includes("application/x-www-form-urlencoded") ?? false
    );
  }

  isMultipart(): boolean {
    // A `FormData` body has no explicit Content-Type yet, `fetch` generates
    // one with the boundary at send time, so the body type is the signal.
    return this._body instanceof FormData;
  }

  /**
   * Whether a multipart attachment named `name` is present, optionally
   * matching its contents and/or filename. Port of `Request::hasFile()`.
   */
  hasFile(name: string, contents?: string, filename?: string): boolean {
    if (!(this._body instanceof FormData)) {
      return false;
    }

    return this._body.getAll(name).some((entry) => {
      if (filename !== undefined) {
        if (!(entry instanceof File) || entry.name !== filename) {
          return false;
        }
      }

      if (contents !== undefined) {
        // Only synchronously-readable contents can be compared here;
        // `attach()` stores a `File` built from the given bytes, so its
        // text is available via the cached string we stashed alongside it.
        const text = entry instanceof File ? attachedText.get(entry) : entry;

        if (text !== contents) {
          return false;
        }
      }

      return true;
    });
  }

  /** A copy with `name` set to `value`, replacing any existing value. */
  withHeader(name: string, value: string): ClientRequest {
    const headers = new Headers(this._headers);
    headers.set(name, value);

    return this.copyWith({ headers });
  }

  /**
   * A copy without `name`.
   *
   * Needed by redirect following, which must drop `Authorization` and
   * `Cookie` on a cross-host hop and `Content-Type` on a 303's rewrite
   * to GET. Removing a header is not expressible through `withHeader()`:
   * an empty string is a header with an empty value, which is not the
   * same thing to a server.
   */
  withoutHeader(name: string): ClientRequest {
    const headers = new Headers(this._headers);
    headers.delete(name);

    return this.copyWith({ headers });
  }

  /** A copy targeting `url` instead. */
  withUrl(url: string): ClientRequest {
    return this.copyWith({ url });
  }

  /**
   * A copy using `method` instead.
   *
   * For redirect following: a 303, and a 301/302 on a POST, rewrite the
   * method to GET. Not part of the fluent builder surface, where the
   * method is chosen by the verb being called.
   */
  withMethod(method: string): ClientRequest {
    return this.copyWith({ method });
  }

  /** A copy carrying `body`, optionally setting `Content-Type` with it. */
  withBody(body: ClientRequestBody, contentType?: string): ClientRequest {
    const headers = new Headers(this._headers);

    if (contentType !== undefined) {
      headers.set("content-type", contentType);
    }

    return this.copyWith({ headers, body });
  }

  private copyWith(overrides: Partial<ClientRequestInit>): ClientRequest {
    return new ClientRequest({
      method: this.method,
      url: this.url,
      headers: this._headers,
      body: this._body,
      data: this._data,
      fetchOptions: this.fetchOptions,
      ...overrides,
    });
  }

  /**
   * The platform `Request` handed to the transport. `duplex: "half"` is set
   * automatically for a `ReadableStream` body. `fetch` throws without it,
   * and it is exactly the kind of detail that should not be the caller's
   * problem.
   */
  toFetchRequest(init: RequestInit = {}): Request {
    const hasBody = this._body !== undefined && this.method !== "GET" && this.method !== "HEAD";
    const requestInit: RequestInit & Record<string, unknown> = {
      method: this.method,
      headers: this._headers,
      ...init,
    };

    if (hasBody) {
      requestInit.body = this._body as FetchBody;

      if (this._body instanceof ReadableStream) {
        requestInit.duplex = "half";
      }
    }

    const request = new Request(this.url, requestInit);
    currentClientRequest.set(request, this);

    return request;
  }
}

/**
 * Links a platform `Request` back to the `ClientRequest` that produced it,
 * so the stub transport can match on `data()`/`hasFile()`. A `Request` has
 * lost the decoded payload, and re-parsing its body is both async and
 * lossy. A `WeakMap`, so it never keeps a request alive.
 */
export const currentClientRequest = new WeakMap<Request, ClientRequest>();

/**
 * Text contents of `File`s built by `attach()`, so `hasFile(name, contents)`
 * can compare synchronously. `File.text()` is async and an assertion
 * callback is not. A `WeakMap`, so it never keeps a file alive.
 */
export const attachedText = new WeakMap<File, string>();
