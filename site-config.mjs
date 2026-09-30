// Port 4174 is reserved for isolated development fixtures.
const localTest = ['127.0.0.1', 'localhost'].includes(location.hostname) && location.port === '4174';
const MIAODA_APP = 'https://tsinghuamc.feishuapp.com/app/app_17ej9a1rbyv';
export const TRACK_API_BASE = localTest ? '/api' : `${MIAODA_APP}/route-data`;
export const ROUTE_MANAGER_URL = localTest ? '' : `${MIAODA_APP}/route-upload`;
