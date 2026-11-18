CREATE TABLE "ira_year" (
	"user_id" uuid NOT NULL,
	"tax_year" integer NOT NULL,
	"facts" jsonb NOT NULL,
	"as_of" date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ira_year_user_id_tax_year_pk" PRIMARY KEY("user_id","tax_year")
);
--> statement-breakpoint
ALTER TABLE "ira_year" ADD CONSTRAINT "ira_year_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;