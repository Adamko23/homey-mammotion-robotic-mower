export type MammotionResponse<T> = {
  code: number;
  msg?: string;
  requestId?: string;
  data?: T;
};

export type MammotionUserInformation = {
  areaCode?: string;
  authType?: string;
  domainAbbreviation?: string;
  email?: string;
  userAccount?: string | number;
  userId?: string;
};

export type MammotionLoginData = {
  access_token: string;
  authorization_code?: string;
  expires_in: number;
  refresh_token: string;
  token_type: string;
  userInformation?: MammotionUserInformation;
};

export type MammotionDeviceInfo = {
  activeTime?: string;
  activeTimestamp?: number;
  deviceId?: string;
  deviceName?: string;
  deviceType?: string;
  generation?: number;
  iconCode?: string;
  iotId?: string;
  isSubscribe?: number;
  productSeries?: string;
  series?: string;
  status?: number;
};

export type MammotionDeviceRecord = {
  bindTime?: number;
  createTime?: string;
  deviceName?: string;
  identityId?: string;
  iotId?: string;
  owned?: number;
  productKey?: string;
  status?: number;
};

export type MammotionDeviceRecords = {
  current?: number;
  pages?: number;
  records?: MammotionDeviceRecord[];
  size?: number;
  total?: number;
};

export type MammotionShareRecord = MammotionDeviceRecord & {
  batchId?: string;
  createTimestamp?: number;
  initiatorAccount?: string;
  initiatorIdentityId?: string;
  isReceiver?: number;
  receiverAccount?: string | null;
  receiverEmail?: string | null;
  receiverIdentityId?: string | null;
  recordId?: string;
  type?: number;
};

export type MammotionShareRecords = {
  current?: number;
  pages?: number;
  records?: MammotionShareRecord[];
  size?: number;
  total?: number;
};

export type MammotionJwtInfo = {
  iot?: string;
  robot?: string;
};
