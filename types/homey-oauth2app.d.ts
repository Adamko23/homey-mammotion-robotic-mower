declare module "homey-oauth2app" {
  import Homey = require("homey");

  export class OAuth2Error extends Error {
    constructor(message: string, statusCode?: number);
    statusCode?: number;
  }

  export class OAuth2Token {
    access_token: string | null;
    refresh_token: string | null;
    token_type: string | null;
    expires_in: number | null;

    constructor(args?: {
      access_token?: string | null;
      refresh_token?: string | null;
      token_type?: string | null;
      expires_in?: number | null;
    });

    isRefreshable(): boolean;
    toJSON(): {
      access_token: string | null;
      refresh_token: string | null;
      token_type: string | null;
      expires_in: number | null;
    };
  }

  export class OAuth2Client {
    static API_URL: string;
    static AUTHORIZATION_URL?: string | null;
    static CLIENT_ID: string;
    static CLIENT_SECRET: string;
    static REDIRECT_URL: string;
    static SCOPES: string[];
    static TOKEN: typeof OAuth2Token;
    static TOKEN_URL: string;

    homey: Homey.App["homey"];

    error(...args: unknown[]): void;
    get(args: { path: string; query?: object; headers?: Record<string, string> }): Promise<unknown>;
    getToken(): OAuth2Token | null;
    log(...args: unknown[]): void;
    onGetOAuth2SessionInformation(): Promise<{ id: string; title: string | null }>;
    onGetTokenByCredentials(args: { username: string; password: string }): Promise<OAuth2Token>;
    onHandleNotOK(args: {
      body: unknown;
      headers: unknown;
      status: number;
      statusText: string;
    }): Promise<Error>;
    onRefreshToken(): Promise<OAuth2Token>;
    onRequestHeaders(args: { headers: Record<string, string> }): Promise<Record<string, string>>;
    post(args: {
      body?: unknown;
      headers?: Record<string, string>;
      json?: object;
      path: string;
      query?: object;
    }): Promise<unknown>;
    save(): void;
    setToken(args: { token: OAuth2Token | null }): void;
  }

  export class OAuth2App extends Homey.App {
    static OAUTH2_CLIENT: typeof OAuth2Client;
    static OAUTH2_DEBUG: boolean;
    static OAUTH2_DRIVERS: string[];
    static OAUTH2_MULTI_SESSION: boolean;

    onOAuth2Init(): Promise<void>;
    onOAuth2Uninit(): Promise<void>;
  }

  export class OAuth2Driver extends Homey.Driver {
    onOAuth2Init(): Promise<void>;
    onOAuth2Uninit(): Promise<void>;
    onPairListDevices(args: { oAuth2Client: OAuth2Client }): Promise<Homey.Driver.PairDevice[]>;
  }

  export class OAuth2Device extends Homey.Device {
    oAuth2Client: OAuth2Client;

    onOAuth2Added(): Promise<void>;
    onOAuth2Deleted(): Promise<void>;
    onOAuth2Destroyed(): Promise<void>;
    onOAuth2Expired(): Promise<void>;
    onOAuth2Init(): Promise<void>;
    onOAuth2Saved(): Promise<void>;
    onOAuth2Uninit(): Promise<void>;
  }

  export const fetch: typeof globalThis.fetch;
}
