/**
 * Shop sign texts for the tube-house sign atlas: generic Vietnamese trades, each with its board
 * and lettering colours. Design text, not taken from any real shop.
 */

/**
 * @typedef {object} ShopName
 * @property {string} text Board text.
 * @property {string} bg Board colour (CSS).
 * @property {string} fg Lettering colour (CSS).
 */

/** @type {readonly ShopName[]} */
export const SHOP_NAMES = Object.freeze([
  { text: 'PHỞ BÒ', bg: '#c8102e', fg: '#ffe066' },
  { text: 'CƠM TẤM', bg: '#1f5fa8', fg: '#ffffff' },
  { text: 'TẠP HÓA', bg: '#2e8b3a', fg: '#ffffff' },
  { text: 'NHÀ THUỐC', bg: '#ffffff', fg: '#0a7a3c' },
  { text: 'TIỆM VÀNG', bg: '#b8001f', fg: '#ffd34d' },
  { text: 'SỬA XE MÁY', bg: '#f2c200', fg: '#1a1a1a' },
  { text: 'CÀ PHÊ', bg: '#5a3418', fg: '#f6e3c5' },
  { text: 'BÁNH MÌ', bg: '#f28c1e', fg: '#ffffff' },
  { text: 'ĐIỆN MÁY', bg: '#0b3d91', fg: '#ffd400' },
  { text: 'BÚN BÒ HUẾ', bg: '#d7263d', fg: '#ffffff' },
  { text: 'THỜI TRANG', bg: '#e75480', fg: '#ffffff' },
  { text: 'HỚT TÓC', bg: '#222222', fg: '#f5f5f5' },
  { text: 'VĂN PHÒNG PHẨM', bg: '#3a7bd5', fg: '#ffffff' },
  { text: 'NHA KHOA', bg: '#e8f4fb', fg: '#0067a5' },
  { text: 'GẠO', bg: '#7fb800', fg: '#ffffff' },
  { text: 'TRÀ SỮA', bg: '#f7d6e0', fg: '#7a2e4a' },
  { text: 'PHOTOCOPY', bg: '#ffffff', fg: '#d0021b' },
  { text: 'ĐIỆN THOẠI', bg: '#ffcc00', fg: '#003a8c' },
  { text: 'MẮT KÍNH', bg: '#004d61', fg: '#ffffff' },
  { text: 'KHÁCH SẠN', bg: '#7b1e3a', fg: '#f3d17a' },
  { text: 'HỦ TIẾU', bg: '#e04f00', fg: '#fff4c2' },
  { text: 'SIM SỐ ĐẸP', bg: '#d10000', fg: '#ffffff' },
  { text: 'NHÀ NGHỈ', bg: '#2b2d6e', fg: '#ff7ab6' },
  { text: 'VẬT LIỆU XÂY DỰNG', bg: '#4b5320', fg: '#ffffff' },
]);
