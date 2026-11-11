import { App, LegacyStackSynthesizer, Tags } from "aws-cdk-lib";
import { PayOnceStack, REGION } from "../lib/payonce-stack.js";

// The PayOnce stack. Run with an aws login session and the budgets' alert address:
//   pnpm cdk synth --profile payonce -c alertEmail=you@example.com
const app: App = new App();
const alertEmail: unknown = app.node.tryGetContext("alertEmail");
if (typeof alertEmail !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alertEmail)) {
  throw new Error("Give the budgets' alert address: -c alertEmail=you@example.com");
}
const account: string | undefined = process.env["CDK_DEFAULT_ACCOUNT"];
if (account === undefined) {
  throw new Error("No AWS account found. Run aws login --profile payonce, then pass --profile payonce");
}

new PayOnceStack(app, "PayOnce", {
  env: { account, region: REGION },
  // Needs no bootstrap stack: the template goes to CloudFormation inline, and the
  // stack has no file or Docker assets.
  synthesizer: new LegacyStackSynthesizer(),
  analyticsReporting: false,
  description: "PayOnce live demo: one EC2 instance behind CloudFront",
  alertEmail,
});
Tags.of(app).add("project", "payonce");
