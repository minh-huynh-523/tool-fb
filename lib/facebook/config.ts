const VERSION = process.env.FACEBOOK_GRAPH_VERSION ?? 'v25.0';

export const FB = {
  VERSION,
  BASE: `https://graph.facebook.com/${VERSION}/`,
  // Optional — chỉ cần nếu FB App gốc bật "Require appsecret_proof".
  APP_SECRET: process.env.FACEBOOK_APP_SECRET || '',
};
