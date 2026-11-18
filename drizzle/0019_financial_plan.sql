CREATE TABLE "financial_plan" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"markdown" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "financial_plan" ADD CONSTRAINT "financial_plan_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;