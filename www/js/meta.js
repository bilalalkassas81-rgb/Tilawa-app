// Static reference data.
export const JUZ = [[1,1],[2,142],[2,253],[3,93],[4,24],[4,148],[5,82],[6,111],[7,88],[8,41],[9,93],[11,6],[12,53],[15,1],[17,1],[18,75],[21,1],[23,1],[25,21],[27,56],[29,46],[33,31],[36,28],[39,32],[41,47],[46,1],[51,31],[58,1],[67,1],[78,1]];
export function juzOf(s, v) { let j = 1; JUZ.forEach(([js, jv], i) => { if (s > js || (s === js && v >= jv)) j = i + 1; }); return j; }

// Folder names on everyayah.com (per-verse MP3s named SSSVVV.mp3).
export const RECITERS = [
  ['Alafasy_128kbps', 'Mishary Rashid Alafasy'],
  ['Abdul_Basit_Murattal_192kbps', 'Abdul Basit (Murattal)'],
  ['Husary_128kbps', 'Mahmoud Khalil Al-Husary'],
  ['Husary_Muallim_128kbps', 'Al-Husary (teaching, with repetition)'],
  ['Minshawy_Murattal_128kbps', 'Mohamed Siddiq Al-Minshawi'],
  ['Abdurrahmaan_As-Sudais_192kbps', 'Abdurrahman As-Sudais'],
  ['Saood_ash-Shuraym_128kbps', 'Saud Ash-Shuraim'],
  ['MaherAlMuaiqly128kbps', 'Maher Al-Muaiqly'],
  ['Ghamadi_40kbps', 'Saad Al-Ghamdi'],
  ['Hudhaify_128kbps', 'Ali Al-Hudhaify'],
  ['Muhammad_Ayyoub_128kbps', 'Muhammad Ayyoub'],
  ['Yasser_Ad-Dussary_128kbps', 'Yasser Ad-Dossari'],
];
export const audioUrl = (rec, s, v) => `https://everyayah.com/data/${rec}/${String(s).padStart(3, '0')}${String(v).padStart(3, '0')}.mp3`;

export const LANGS = [['en', 'English'], ['fr', 'Français'], ['es', 'Español'], ['id', 'Bahasa Indonesia'], ['tr', 'Türkçe'], ['ru', 'Русский'], ['ur', 'اردو'], ['bn', 'বাংলা'], ['zh', '中文'], ['sv', 'Svenska']];

export const TOTAL_VERSES = 6236;
const AR = '٠١٢٣٤٥٦٧٨٩';
export const toAr = (n) => String(n).replace(/\d/g, (d) => AR[d]);
export const BASMALA = 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ';
