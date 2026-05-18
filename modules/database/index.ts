export {
  initDB,
  upsert,
  searchVector,
  getSince,
  getMessagesInRange,
  getLatestMessage,
  getMessage,
  deleteMessage,
  dropDB,
} from './db'
export type { IDBSchema } from './schema'
