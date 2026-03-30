import dotenv from "dotenv";
import { env } from "./env";
import { initializeCassandra } from "./db";
import { app } from "./app";

dotenv.config();

const port = Number(env.DMS_PORT);
initializeCassandra()
  .then(() => {
    app.listen(port, () => {
      console.log(`DMS service running on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("[dms] failed to initialize", error);
    process.exit(1);
  });
