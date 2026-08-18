import { OAuth2Token } from "homey-oauth2app";

import type { MammotionUserInformation } from "./mammotionTypes";

type MammotionOAuth2TokenArgs = {
  access_token?: string | null;
  refresh_token?: string | null;
  token_type?: string | null;
  expires_in?: number | null;
  authorization_code?: string | null;
  userInformation?: MammotionUserInformation | null;
};

type MammotionOAuth2TokenJson = ReturnType<OAuth2Token["toJSON"]> & {
  authorization_code: string | null;
  userInformation: MammotionUserInformation | null;
};

export default class MammotionOAuth2Token extends OAuth2Token {
  authorization_code: string | null;
  userInformation: MammotionUserInformation | null;

  constructor(args: MammotionOAuth2TokenArgs = {}) {
    super(args);

    this.authorization_code = args.authorization_code ?? null;
    this.userInformation = args.userInformation ?? null;
  }

  toJSON(): MammotionOAuth2TokenJson {
    return {
      ...super.toJSON(),
      authorization_code: this.authorization_code,
      userInformation: this.userInformation,
    };
  }
}
