CREATE TABLE "manual_holding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"asset_class" text NOT NULL,
	"value" numeric(19, 4) NOT NULL,
	"as_of" date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_holding_user_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
ALTER TABLE "manual_holding" ADD CONSTRAINT "manual_holding_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;