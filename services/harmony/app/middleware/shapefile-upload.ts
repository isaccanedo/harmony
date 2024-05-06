import multer from 'multer';
import multerS3 from 'multer-s3';
import * as crypto from 'crypto';
import { RequestHandler } from 'express';
import env from '../util/env';
import { S3ObjectStore } from '../util/object-store/s3-object-store';

/**
 * Build a middleware for uploading shapefiles passed in with the request to S3
 *
 * @returns A middleware object that handles shapefile uploads
 */
export default function buildShapefileUploadMiddleware(): RequestHandler {
  const { uploadBucket } = env;
  const s3Store = new S3ObjectStore();
  const shapefilePrefix = 'temp-user-uploads';

  const upload = multer({
    storage: multerS3({
      s3: s3Store.s3,
      key: (_request, _file, callback) => {
        crypto.randomBytes(16, (err, raw) => {
          callback(err, err ? undefined : `${shapefilePrefix}/${raw.toString('hex')}`);
        });
      },
      bucket: uploadBucket,
    }),
    limits: {
      fields: env.maxPostFields, // Maximum number of non-file fields to accept
      fileSize: env.maxPostFileSize, // Maximum size for shapefiles
      files: 1, // Maximum number of files to accept
      parts: env.maxPostFileParts, // Maximum number of multipart parts to accept
    },
  });
  const uploadFields = [{ name: 'shapefile', maxCount: 1 }];
  return upload.fields(uploadFields);
}
