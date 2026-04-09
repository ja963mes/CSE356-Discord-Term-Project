CREATE TABLE "read_state" (
	"user_id" uuid NOT NULL,
	"context_type" text NOT NULL,
	"context_id" uuid NOT NULL,
	"last_read_timeuuid" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "read_state_user_id_context_type_context_id_pk" PRIMARY KEY("user_id","context_type","context_id")
);
--> statement-breakpoint
ALTER TABLE "read_state" ADD CONSTRAINT "read_state_user_id_users_internal_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("internal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "read_state_user_context_idx" ON "read_state" USING btree ("user_id","context_type");