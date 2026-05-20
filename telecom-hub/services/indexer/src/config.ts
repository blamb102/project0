import 'dotenv/config'

export const config = {
  ftpBase: process.env.THREEGPP_FTP_BASE ?? 'https://www.3gpp.org/ftp',
  meilisearchUrl: process.env.MEILISEARCH_URL ?? 'http://localhost:7700',
  meilisearchKey: process.env.MEILISEARCH_MASTER_KEY ?? 'masterKey',
  crawlStatePath: process.env.CRAWL_STATE_PATH ?? '.crawl-state.json',
  batchSize: Number(process.env.CRAWL_BATCH_SIZE ?? 50),
}

// Map CLI WG names → FTP sub-paths
export const WG_PATHS: Record<string, string> = {
  RAN1:  'TSG_RAN/WG1_RL1',
  RAN2:  'TSG_RAN/WG2_RL2',
  RAN3:  'TSG_RAN/WG3_Iu',
  RAN4:  'TSG_RAN/WG4_Radio',
  SA1:   'TSG_SA/WG1_Serv',
  SA2:   'TSG_SA/WG2_Arch',
  SA3:   'TSG_SA/WG3_Security',
  SA4:   'TSG_SA/WG4_CODEC',
  CT1:   'TSG_CT/WG1_MM-CC-SM_ex-CN1',
  CT4:   'TSG_CT/WG4_protocollars',
}

// Map CLI WG names → TDoc index filename prefix (e.g. R1_Index(2024).zip)
export const WG_PREFIXES: Record<string, string> = {
  RAN1: 'R1',
  RAN2: 'R2',
  RAN3: 'R3',
  RAN4: 'R4',
  SA1:  'S1',
  SA2:  'S2',
  SA3:  'S3',
  SA4:  'S4',
  CT1:  'C1',
  CT4:  'C4',
}
