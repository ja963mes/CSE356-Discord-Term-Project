import { S3Client, CreateBucketCommand, HeadBucketCommand, PutBucketPolicyCommand, PutBucketCorsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";

export const s3 = new S3Client({
  endpoint: env.MINIO_ENDPOINT,
  region: "us-east-1", // MinIO ignores region but SDK requires it
  credentials: {
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true, // Required for MinIO — uses path-style URLs (host/bucket/key)
  // MinIO returns 501 for checksum headers added by default in SDK v3.x; only send when required
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

export async function initializeBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.MINIO_BUCKET }));
    console.log(`[minio] bucket "${env.MINIO_BUCKET}" already exists`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: env.MINIO_BUCKET }));
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: env.MINIO_BUCKET,
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: ["*"] },
              Action: ["s3:GetObject"],
              Resource: [`arn:aws:s3:::${env.MINIO_BUCKET}/*`],
            },
          ],
        }),
      })
    );
    console.log(`[minio] bucket "${env.MINIO_BUCKET}" created with public read policy`);
  }

  await s3.send(
    new PutBucketCorsCommand({
      Bucket: env.MINIO_BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ["*"],
            AllowedMethods: ["GET", "PUT", "HEAD", "DELETE"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    })
  );
  console.log(`[minio] CORS configured for bucket "${env.MINIO_BUCKET}"`);
}

/** Generate a presigned PUT URL for direct browser upload. Expires in 15 minutes. */
export async function presignUpload(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: env.MINIO_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 900 }
  );
}

/** Convert a stored object key to a public URL. */
export function keyToUrl(key: string): string {
  return `${env.ATTACHMENT_BASE_URL}/${key}`;
}
