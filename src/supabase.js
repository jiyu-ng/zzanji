import { createClient } from '@supabase/supabase-js';

// 가계부 데이터 저장 (모이 Supabase 프로젝트의 ledger 테이블 재사용).
// publishable 키는 공개돼도 안전(RLS로 보호).
const SUPABASE_URL = 'https://mdkizfamvgtaceifysvh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_lA7If1jf1KecJXrOFSPTJw_7ZxbTpRM';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
