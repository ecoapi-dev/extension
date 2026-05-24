const PROD_API_BASE_URL = "https://api.recost.dev";
const PROD_DASHBOARD_BASE_URL = "https://recost.dev";

export const RECOST_API_BASE_URL =
  process.env.RECOST_API_BASE_URL?.trim() || PROD_API_BASE_URL;

export const RECOST_DASHBOARD_BASE_URL =
  process.env.RECOST_DASHBOARD_BASE_URL?.trim() || PROD_DASHBOARD_BASE_URL;
