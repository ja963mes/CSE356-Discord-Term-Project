CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"internal_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_uid" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "identities_provider_provider_uid_unique" UNIQUE("provider","provider_uid")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"internal_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_internal_id_users_internal_id_fk" FOREIGN KEY ("internal_id") REFERENCES "public"."users"("internal_id") ON DELETE cascade ON UPDATE no action;