import sourceMapSupport from "source-map-support";
import { OAuth2App } from "homey-oauth2app";

import MammotionOAuth2Client from "./lib/MammotionOAuth2Client";

sourceMapSupport.install();

class MammotionApp extends OAuth2App {
  static OAUTH2_CLIENT = MammotionOAuth2Client;
  static OAUTH2_DRIVERS = ["mower"];
  static OAUTH2_MULTI_SESSION = true;

  async onOAuth2Init(): Promise<void> {
    this.log("Mammotion app initialized");
  }
}

export = MammotionApp;
