const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const sharp = require('sharp');

const CONFIG = {
  bp: {
    x: {
      key: 'gfuqsdynoz6de0sk6ilw36g8',
      secret: 'ld4z4jw21k6vydy3aw2edm0uqvogzzy2'
    }
  },
  appId: '104',
  gid: '2840569028',
  appVersion: '7.33.1',
  userAgent: 'BeautyPlus/7.33.1 (Android 17; com.commsource.beautyplus; ID)',
  pixccId: '40002',
  countryCode: 'ID',
  clientName: 'beautyplus-android',
  language: 'id',
  outputDir: 'beautyplus',
  imageScene: 'ai_hd',
  videoScene: 'hd',
  videoType: 4004,
  videoFps: 30,
  pollInterval: 3000,
  timeout: 300000,
};

const mda = {
  ext: {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  },
  mime: {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
  }
};

function detectMimeType(input) {
  if (typeof input === 'string') {
    return mda.mime[path.extname(input).toLowerCase()] ?? null;
  }
  if (Buffer.isBuffer(input)) {
    const b = input;
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (b.length >= 8 && ['ftyp', 'moov'].includes(b.subarray(4, 8).toString('ascii'))) return 'video/mp4';
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function generateNonce(length = 8) {
  const alphabet = '1234567890qwertyuiopasdfghjklzxcvbnmQWERTYUIOPASDFGHJKLZXCVBNM-_+';
  return Array.from({ length }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}

function generateFirebaseId() {
  return crypto.randomBytes(16).toString('hex');
}

function generateFirebaseToken() {
  const head = crypto.randomBytes(8).toString('base64url');
  const body = crypto.randomBytes(64).toString('base64url');
  return `${head}:APA91b${body}`;
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function getSignedHeaders() {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const randomNonce = generateNonce();
  const canonical = `app_key=${CONFIG.bp.x.key}&timestamp=${timestamp}&nonce=${randomNonce}`;
  const sign = crypto.createHmac('sha256', CONFIG.bp.x.secret).update(canonical).digest('base64');

  const clientpix = {
    country_code: CONFIG.countryCode,
    pixcc_id: CONFIG.pixccId,
    app_version: CONFIG.appVersion,
    client: CONFIG.clientName,
    time: String(Date.now() * 1000),
    app_id: CONFIG.appId,
  };

  return {
    'X-App-Key': CONFIG.bp.x.key,
    'X-Nonce': randomNonce,
    'X-Timestamp': timestamp,
    'X-Sign': encodeURIComponent(sign),
    'X-App-Id': CONFIG.appId,
    gid: CONFIG.gid,
    hw_gid: CONFIG.gid,
    'User-Agent': CONFIG.userAgent,
    version: CONFIG.appVersion,
    'x-pixcc-client': Buffer.from(JSON.stringify(clientpix)).toString('base64'),
  };
}

function createSignedAxios(bUrl) {
  const ins = axios.create({ baseURL: bUrl, timeout: CONFIG.timeout });

  ins.interceptors.request.use((config) => {
    config.headers = config.headers || {};
    Object.assign(config.headers, getSignedHeaders());
    return config;
  });

  ins.interceptors.response.use(
    (response) => {
      const body = response.data;
      if (body && typeof body === 'object' && body.code !== undefined && body.code !== 0 && body.code !== 200) {
        throw Object.assign(new Error(body.message || `API error code ${body.code}`), { code: body.code, response });
      }
      return response;
    },
    (error) => {
      if (error.response?.data) {
        const body = error.response.data;
        const msg = body?.message || body?.error_msg || error.message;
        return Promise.reject(
          Object.assign(new Error(`HTTP ${error.response.status} (${error.config?.url}): ${msg}`), {
            status: error.response.status,
            response: error.response,
          })
        );
      }
      return Promise.reject(error);
    }
  );

  return ins;
}

const apiClient = createSignedAxios();
const utilityClient = createSignedAxios();

async function downloadBuffer(url) {
  const { data } = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(data);
}

async function pollTask(taskFunc, urlPath, opt, timeout) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const { data: body = {} } = await taskFunc(urlPath, opt);
    const data = body.data || {};

    if (data.status === 'success') {
      return data.outputData ?? data.result?.resultUrl ?? data.outputs?.[0];
    }

    if (['failed', 'error', 'failure'].includes(String(data.status).toLowerCase())) {
      throw new Error(data.message || 'Enhancement task failed');
    }

    await sleep(CONFIG.pollInterval);
  }

  throw new Error(`Polling timed out after ${timeout}ms`);
}

async function getStorageToken() {
  const { data } = await utilityClient.get('https://utility.pixocial.com/api/v1/storage/client/security_token', {
    params: {
      bucket: 'aibiz',
      token_expire_time: '43200'
    }
  });
  if (!data?.data) throw new Error('Storage token response did not contain data');
  return data.data;
}

async function uploadFile(input, contentType, filename, prefix = 'beautyplustemp') {
  if (!Buffer.isBuffer(input)) throw new TypeError('Input must be a Buffer');

  const resolvedContentType = contentType ?? detectMimeType(input) ?? 'application/octet-stream';
  const ext = mda.ext[resolvedContentType] ?? '.bin';
  const resolvedFilename = filename ?? `upload_${Date.now()}${ext}`;

  const storage = await getStorageToken();
  const region = storage.region || 'us-east-1';
  const bucket = storage.bucket || 'aibiz';
  const endpoint = new URL(storage.end_point || 'https://object.pixocial.com');
  const fileExt = path.extname(resolvedFilename).toLowerCase();
  const objectKey = `${prefix}/${crypto.randomUUID()}_${Date.now()}${fileExt}`;
  const canonicalUri = `${endpoint.pathname.replace(/\/$/, '')}/${bucket}/${objectKey}`.replace(/\/+/g, '/');

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input);
  const contentMd5 = crypto.createHash('md5').update(input).digest('base64');

  const rawHeaders = {
    'content-md5': contentMd5,
    'content-type': resolvedContentType,
    host: endpoint.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'x-amz-security-token': storage.security_token,
  };

  const sortedKeys = Object.keys(rawHeaders).sort();
  const signedHeadersStr = sortedKeys.join(';');
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${rawHeaders[k]}\n`).join('');
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeadersStr, payloadHash].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${storage.secret_key}`, dateStamp), region), 's3'),
    'aws4_request'
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${storage.access_key}/${scope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

  const uploadUrl = `${endpoint.origin}${canonicalUri}`;
  const { status } = await axios.put(uploadUrl, input, {
    headers: { ...rawHeaders, Authorization: authorization },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  if (status < 200 || status >= 300) throw new Error(`Upload failed with HTTP ${status}`);
  return uploadUrl;
}

async function probeVideo(buf, fallbackFps = 30) {
  let durSec = 0, visual = false, szCount = 0, ttCount = 0;
  let width = 0, height = 0;

  (function walk(s, e, inTrak) {
    for (let i = s; i + 8 <= e; ) {
      let size = buf.readUInt32BE(i);
      const type = buf.toString('latin1', i + 4, i + 8);
      let hdr = 8;

      if (size === 1) {
        size = Number(buf.readBigUInt64BE(i + 8));
        hdr = 16;
      } else if (size === 0) {
        size = e - i;
      }

      if (size < hdr || i + size > e) break;
      const a = i + hdr, b = i + size;

      if (type === 'mvhd') {
        const v = buf[a];
        const o = a + 4 + (v === 1 ? 16 : 8);
        const ts = buf.readUInt32BE(o);
        const dur = v === 1 ? Number(buf.readBigUInt64BE(o + 4)) : buf.readUInt32BE(o + 4);
        if (ts) durSec = dur / ts;
      } else if (type === 'stsd' && inTrak) {
        visual = /^(avc1|hev1|hvc1|mp4v|vp09|av01)/.test(buf.toString('latin1', a + 12, a + 16));
        if (visual && !width) {
          width = buf.readUInt16BE(a + 40);
          height = buf.readUInt16BE(a + 42);
        }
      } else if (type === 'stsz' && inTrak && visual && !szCount) {
        szCount = buf.readUInt32BE(a + 8);
      } else if (type === 'stts' && inTrak && visual && !ttCount) {
        const n = buf.readUInt32BE(a + 4);
        for (let k = 0, o = a + 8; k < n; k++) {
          ttCount += buf.readUInt32BE(o);
          o += 8;
        }
      }

      walk(a, b, inTrak || type === 'trak');
      i += size;
    }
  })(0, buf.length, false);

  if (!durSec || durSec <= 0) {
    throw new Error('Could not determine video duration from container metadata');
  }

  const frames = szCount || ttCount;
  const fps = frames && durSec ? Math.round(frames / durSec) : (CONFIG.videoFps || fallbackFps);

  return {
    duration: durSec,
    durationMs: Math.round(durSec * 1000),
    fps,
    frames,
    width,
    height
  };
}

async function applyMasksToImage(input, maskBuffers) {
  const { data: rgba, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const totalPixels = width * height;
  const combinedMask = Buffer.alloc(totalPixels, 0);

  for (const maskBuf of maskBuffers) {
    const { data: maskRaw } = await sharp(maskBuf).resize(width, height, { fit: 'fill' }).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });

    for (let i = 0; i < totalPixels; i++) {
      if (maskRaw[i] > combinedMask[i]) combinedMask[i] = maskRaw[i];
    }
  }

  for (let i = 0; i < totalPixels; i++) {
    rgba[i * 4 + 3] = combinedMask[i];
  }

  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function enhance(input, options = {}) {
  const contentType = options.contentType || detectMimeType(input);
  const timeout = options.timeout ?? CONFIG.timeout;

  if (contentType?.startsWith('image/')) {
    const inputUrl = await uploadFile(input, contentType);
    const scene = options.scene || CONFIG.imageScene;

    const img = createSignedAxios('https://image-tools.pixocial.com');

    const { data: created } = await img.post('/api/v2/image/quality-enhance', {
      enableSaveDB: false,
      outputDir: CONFIG.outputDir,
      inputData: inputUrl,
      scene,
    });

    const taskId = created?.data?.taskId;
    if (!taskId) throw new Error('Photo task response did not contain taskId');

    const pollUrl = `/api/v2/image/quality-enhance`;
    const resultUrl = await pollTask(img.get, pollUrl, {
      params: { taskId }
    }, timeout);

    return downloadBuffer(resultUrl);
  } else if (contentType?.startsWith('video/')) {
    let { duration, fps } = options;
    if (!duration || !Number.isFinite(duration) || duration <= 0) {
      const probed = await probeVideo(input);
      duration = probed.duration;
      fps = fps || probed.fps;
    }
    fps = fps ?? CONFIG.videoFps;

    const firebaseToken = generateFirebaseToken();
    const firebaseId = generateFirebaseId();
    const scene = options.scene || CONFIG.videoScene;
    const vid = createSignedAxios('https://video-tools.pixocial.com');

    const { data: preCreate } = await vid.post('/api/v1/tasks/pre-create', {
      videoDuration: duration,
      firebaseToken,
      firebaseId,
      language: CONFIG.language,
      type: CONFIG.videoType,
      videoFps: fps,
      scene,
      ...(scene === 'ai_hd' ? { ext: { duration } } : {}),
    });

    const taskId = preCreate?.data?.taskId;
    if (!taskId) throw new Error('Video pre-create response did not contain taskId');

    const videoUrl = await uploadFile(input, contentType);
    const { data: created } = await vid.post('/api/v2/video/quality-enhance', {
      outputDir: CONFIG.outputDir,
      firebaseToken,
      videoUrl,
      firebaseId,
      enableSaveDB: true,
      language: CONFIG.language,
      taskId,
      scene,
    });

    const finalTaskId = created?.data?.taskId || taskId;
    const pollUrl = `/api/v2/video/quality-enhance/${encodeURIComponent(finalTaskId)}`;
    const resultUrl = await pollTask(vid.get, pollUrl, {}, timeout);

    return downloadBuffer(resultUrl);
  } else {
    throw new Error(`Unsupported media type: ${contentType || typeof input}`);
  }
}

async function removebg(input, options = {}) {
  const contentType = options.contentType || detectMimeType(input);
  if (!contentType?.startsWith('image/')) {
    throw new Error(`Remove background only supports images.`);
  }

  const inputUrl = await uploadFile(input, contentType);

  const { data: body } = await apiClient.post('https://v2.lab.pixocial.com/v1/sod_2c_async', {
    parameter: { nMask: true, blackwhite: true, post_matting: true },
    media_info_list: [{
      media_data: inputUrl,
      media_profiles: { media_data_type: 'url' },
    }],
  });

  if (body.error_code !== undefined && body.error_code !== 0 && body.error_code !== 200) {
    throw new Error(`Remove-bg API submit error: ${body.error_msg || JSON.stringify(body)}`);
  }

  const msgId = body.msg_id;
  if (!msgId) throw new Error('Remove-bg task submit did not return msg_id');

  const timeout = options.timeout ?? CONFIG.timeout;
  const deadline = Date.now() + timeout;
  let mediaList = [];

  while (Date.now() < deadline) {
    await sleep(CONFIG.pollInterval);
    try {
      const { data: qBody } = await apiClient.get('https://v2.lab.pixocial.com/v1/query', {
        params: { msg_id: msgId }
      });

      if (qBody.error_code !== undefined && qBody.error_code !== 0 && qBody.error_code !== 200) {
        throw new Error(`Remove-bg task failed: ${qBody.error_code} — ${qBody.error_msg || 'Unknown error'}`);
      }

      if (Array.isArray(qBody.media_info_list) && qBody.media_info_list.length > 0) {
        mediaList = qBody.media_info_list;
        break;
      }
    } catch (err) {
      if (err.message.startsWith('Remove-bg task failed')) throw err;
    }
  }

  if (mediaList.length === 0) throw new Error('Remove-bg task timed out');

  const maskBuffers = await Promise.all(
    mediaList
      .filter((item) => typeof item.media_data === 'string' && item.media_data.length > 0)
      .map((item) =>
        item.media_data.startsWith('http')
          ? downloadBuffer(item.media_data)
          : Promise.resolve(Buffer.from(item.media_data, 'base64'))
      )
  );

  if (maskBuffers.length === 0) throw new Error('Remove-bg API returned empty mask data');

  return applyMasksToImage(input, maskBuffers);
}

const app = express();
const PORT = process.env.PORT || 7860;

app.use(cors({ origin: '*' }));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'Echanced AI Engine', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/enhance', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File belum dipilih.' });
    }
    const mime = detectMimeType(req.file.buffer) || req.file.mimetype;
    const resultBuffer = await enhance(req.file.buffer, { contentType: mime });
    const outMime = detectMimeType(resultBuffer) || (mime.startsWith('video/') ? 'video/mp4' : 'image/jpeg');
    res.set('Content-Type', outMime);
    res.send(resultBuffer);
  } catch (err) {
    next(err);
  }
});

app.post('/api/removebg', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File gambar belum dipilih.' });
    }
    const mime = detectMimeType(req.file.buffer) || req.file.mimetype;
    if (!mime.startsWith('image/')) {
      return res.status(400).json({ error: 'Hapus background cuma bisa buat file foto/gambar ya.' });
    }
    const resultBuffer = await removebg(req.file.buffer, { contentType: mime });
    res.set('Content-Type', 'image/png');
    res.send(resultBuffer);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error('[SERVER_ERROR]:', err.message);
  res.status(500).json({
    error: 'Gagal memproses media di server. Pastikan ukuran dan format file sesuai.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Echanced Server running on http://0.0.0.0:${PORT}`);
});