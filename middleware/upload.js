const multer = require('multer');
const path = require('path');
const fs = require('fs');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const imagesDir = path.join(__dirname, '..', 'uploads', 'images');
const pdfsDir = path.join(__dirname, '..', 'uploads', 'pdfs');
const datasheetsDir = path.join(__dirname, '..', 'uploads', 'datasheets');

ensureDir(imagesDir);
ensureDir(pdfsDir);
ensureDir(datasheetsDir);

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, imagesDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`)
});

const pdfStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, pdfsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`)
});

const datasheetStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, datasheetsDir),
  filename: (req, file, cb) => cb(null, `ds_${Date.now()}${path.extname(file.originalname)}`)
});

const uploadImages = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\/(jpeg|png|gif|webp)/.test(file.mimetype))
});

const uploadPdf = multer({
  storage: pdfStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf')
});

const uploadDatasheet = multer({
  storage: datasheetStorage,
  limits: { fileSize: 20 * 1024 * 1024 }
});

module.exports = { uploadImages, uploadPdf, uploadDatasheet };
