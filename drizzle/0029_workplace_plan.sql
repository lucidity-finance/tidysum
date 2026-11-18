CREATE TABLE "workplace_plan" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"facts" jsonb NOT NULL,
	"as_of" date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workplace_plan" ADD CONSTRAINT "workplace_plan_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_plan" ADD CONSTRAINT "workplace_plan_account_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."account"("id","user_id") ON DELETE cascade ON UPDATE no action;