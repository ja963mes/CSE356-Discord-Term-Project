import dotenv from "dotenv";
import { env } from "./env";
import { initializeCassandra } from "./db";
import { initializeBucket } from "./minio";
import { app } from "./app";

dotenv.config();

const port = Number(env.DMS_PORT);
Promise.all([initializeCassandra(), initializeBucket()])
  .then(() => {
    app.listen(port, () => {
      console.log(`DMS service running on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("[dms] failed to initialize", error);
    process.exit(1);
  });
