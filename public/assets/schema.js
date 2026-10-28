/* Solid Gold Systems Tracker - single source of truth for the intake form,
   the lead detail view, the build checklist and the zip export.
   Add or rename a question here and every screen picks it up. */
(function (root) {
  "use strict";

  var SECTIONS = [
    {
      /* Answers from the short form on websites.solidgoldsystems.com.
         internal: shown in the Tracker and export, never rendered in the intake form. */
      id: "booking", num: "00", title: "Booking Form", internal: true, sub: "Their answers to the short form before booking.",
      fields: [
        { id: "lp_industry", label: "Type of business", type: "text", half: true },
        { id: "lp_website_status", label: "Current website", type: "text", half: true },
        { id: "lp_logo_need", label: "Logo need", type: "text", half: true },
        { id: "lp_website_url", label: "Existing website", type: "url", half: true },
        { id: "lp_business_description", label: "What the business does", type: "textarea" },
        { id: "lp_key_offerings", label: "Key offerings to showcase", type: "textarea" }
      ]
    },
    {
      id: "business", num: "01", title: "Your Business", sub: "The basics that go on your site.",
      fields: [
        { id: "business_name", label: "Business name", type: "text", req: true, auto: "organization" },
        { id: "contact_name", label: "Your name", type: "text", req: true, half: true, auto: "name" },
        { id: "contact_email", label: "Your email", type: "email", req: true, half: true, auto: "email", hint: "So we can reach you about the build." },
        { id: "business_phone", label: "Business phone (shown on site)", type: "tel", req: true, half: true, auto: "tel" },
        { id: "business_email", label: "Business email (shown on site)", type: "email", half: true },
        { id: "current_website", label: "Current website", labelNote: "if you have one", type: "url", ph: "yourbusiness.com", auto: "url" },
        { id: "business_address", label: "Business address", type: "text", ph: "Street, city, state, ZIP", auto: "street-address" },
        { id: "show_address", label: "Show your address on the site?", type: "choice", options: ["Yes, show it", "No, service area only"] },
        { id: "business_hours", label: "Business hours", type: "text", half: true, ph: "Mon–Fri 8am–6pm, Sat 9am–2pm" },
        { id: "service_area", label: "Service area", type: "text", half: true, ph: "Towns, counties, or radius" },
        { id: "year_founded", label: "Year founded", type: "text", half: true, mode: "numeric" },
        { id: "license_number", label: "License #", type: "text", half: true, labelNote: "if it needs to be shown" }
      ]
    },
    {
      id: "services", num: "02", title: "Services", sub: "What you want to be known for. Your top services get featured first.",
      fields: [
        { id: "service_1", label: "#1 priority service", type: "text", req: true, ph: "The job you want more of" },
        { id: "service_2", label: "#2 priority service", type: "text", half: true },
        { id: "service_3", label: "#3 priority service", type: "text", half: true },
        { id: "services_list", label: "Full list of services", type: "textarea", req: true, ph: "One per line", rows: 5 },
        { id: "why_choose", label: "Why should customers pick you?", type: "textarea", ph: "Warranties, experience, family-owned, fast turnaround, financing, certifications...", hint: "We'll use this to write your site copy." },
        { id: "specials", label: "Current specials or offers", type: "textarea", rows: 2, ph: "Free estimates, 10% off first service, financing available..." }
      ]
    },
    {
      id: "brand", num: "03", title: "Logo & Brand", sub: "Highest-quality versions you have. PNG or SVG with a transparent background is best.",
      fields: [
        { id: "logo", label: "Logo", type: "files", kind: "logo", half: true, max: 5, accept: "image/*,.svg,.pdf,.ai,.eps", btn: "Upload logo", btnSub: "PNG, SVG, JPG or PDF" },
        { id: "icon", label: "Icon", type: "files", kind: "icon", half: true, max: 3, accept: "image/*,.svg,.pdf", btn: "Upload icon", btnSub: "The square/symbol version of your logo" },
        { id: "no_logo", label: "I don't have a logo / I want a new one", type: "check" },
        { id: "brand_colors", label: "Brand colors", type: "text", half: true, ph: "e.g. navy and orange, or #1A2B3C" },
        { id: "inspiration_sites", label: "Websites you like", type: "text", half: true, ph: "Links, competitors or not" }
      ]
    },
    {
      id: "photos", num: "04", title: "Photos of Your Work", sub: "Past jobs, before/afters, products, your shop or trucks, and you and your team. Real photos convert far better than stock.",
      fields: [
        { id: "photos_link", label: "Link to your photos", labelNote: "recommended", type: "url", ph: "Google Drive, Dropbox, iCloud or Google Photos link", hint: "Make the link viewable by anyone who has it." },
        { id: "photos", label: "Or upload them here", type: "files", kind: "photos", max: 80, accept: "image/*,video/*,.heic,.heif", btn: "Upload photos", btnSub: "Full quality. Select as many as you like." }
      ]
    },
    {
      id: "reviews", num: "05", title: "Testimonials & Reviews", sub: "Social proof is one of the biggest drivers of calls. Send whatever you've got.",
      fields: [
        { id: "google_reviews_link", label: "Google reviews link", type: "url", half: true, ph: "Link to your Google reviews" },
        { id: "other_review_sites", label: "Other review sites", type: "text", half: true, ph: "Yelp, Angi, HomeAdvisor, Houzz, Facebook." },
        { id: "testimonials", label: "Your favorite testimonials", type: "textarea", rows: 4, ph: "Paste reviews here, with the customer's first name and town if you have them." },
        { id: "review_screenshots", label: "Review screenshots", type: "files", kind: "reviews", max: 20, accept: "image/*,.pdf,.heic", btn: "Upload screenshots", btnSub: "Image or PDF" },
        { id: "review_names", label: "Can we use customer first names with reviews?", type: "choice", options: ["Yes", "Initials only", "No names"] }
      ]
    },
    {
      id: "social", num: "06", title: "Social & Online Links", sub: "Paste the full link for any you have. Leave the rest blank.",
      fields: [
        { id: "instagram", label: "Instagram", type: "url", half: true, ph: "https://instagram.com/..." },
        { id: "facebook", label: "Facebook", type: "url", half: true, ph: "https://facebook.com/..." },
        { id: "tiktok", label: "TikTok", type: "url", half: true, ph: "https://tiktok.com/@..." },
        { id: "x", label: "X (Twitter)", type: "url", half: true, ph: "https://x.com/..." },
        { id: "linkedin", label: "LinkedIn", type: "url", half: true, ph: "https://linkedin.com/..." },
        { id: "pinterest", label: "Pinterest", type: "url", half: true, ph: "https://pinterest.com/..." },
        { id: "youtube", label: "YouTube", type: "url", half: true, ph: "https://youtube.com/@..." },
        { id: "google_business", label: "Google Business Profile", type: "url", half: true, ph: "Google Maps link" },
        { id: "other_links", label: "Other", type: "text", half: true, ph: "Nextdoor, Houzz, etc." },
        { id: "booking_link", label: "Online booking link", type: "url", half: true, ph: "Calendly, Jobber, Housecall Pro..." }
      ]
    },
    {
      id: "domain", num: "07", title: "Domain", sub: "Your web address, like yourbusiness.com.",
      fields: [
        { id: "has_domain", label: "Do you already own a domain?", type: "choice", req: true, options: ["Yes, I have one", "No, I need one", "Not sure"] },
        { id: "domain_1", label: "1st choice", type: "text", half: true, ph: "yourbusiness.com" },
        { id: "domain_2", label: "2nd choice", type: "text", half: true, ph: "yourbusinessli.com" },
        { id: "domain_note", type: "note", text: "Don't put passwords in this form. If we need access to your domain, we'll walk you through it on a call." }
      ]
    },
    {
      id: "final", num: "08", title: "Leads & Final Details", sub: "",
      fields: [
        { id: "leads_email", label: "Where should website inquiries go?", type: "email", req: true, half: true, ph: "Email for contact form submissions" },
        { id: "contact_methods", label: "How do you want customers to reach you?", type: "multi", half: true, options: ["Call", "Text", "Form", "Book online"] },
        { id: "anything_else", label: "Anything else we should know?", type: "textarea", rows: 4, ph: "Must-haves, things you hate about your current site, deadlines..." }
      ]
    }
  ];

  /* Kinds of files a lead can have. Client kinds come from the intake form;
     SGS kinds are added in the Tracker while building. Order = export folders. */
  var FILE_KINDS = [
    { id: "logo", label: "Logo", source: "client" },
    { id: "icon", label: "Icon", source: "client" },
    { id: "photos", label: "Site photos", source: "client" },
    { id: "reviews", label: "Review screenshots", source: "client" },
    { id: "banner", label: "Text preview banner", source: "sgs" },
    { id: "hero", label: "Hero video", source: "sgs" },
    { id: "headshots", label: "Owner / team headshots", source: "sgs" },
    { id: "badges", label: "Licenses, insurance, awards", source: "sgs" },
    { id: "before_after", label: "Before / after photos", source: "sgs" },
    { id: "brand_guide", label: "Brand / style guide", source: "sgs" },
    { id: "other", label: "Other files", source: "sgs" }
  ];

  /* The SGS Website Build Checklist. `from` returns true when the intake
     already supplied that item, so the Tracker can flag it "from intake". */
  function has(a, k) { return !!(a[k] && String(a[k]).trim()); }
  function nfiles(files, kind) { return files.filter(function (f) { return f.kind === kind; }).length; }

  var CHECKLIST = [
    { id: "files", title: "Files", items: [
      { id: "logo", label: "Logo", from: function (a, f) { return nfiles(f, "logo") > 0; } },
      { id: "icon", label: "Icon", from: function (a, f) { return nfiles(f, "icon") > 0; } },
      { id: "banner", label: "Text preview banner", from: function (a, f) { return nfiles(f, "banner") > 0; } },
      { id: "hero", label: "Hero video", note: "optional", from: function (a, f) { return nfiles(f, "hero") > 0; } },
      { id: "photos", label: "Site photos", note: "gallery, products, place of business", from: function (a, f) { return nfiles(f, "photos") > 0 || has(a, "photos_link"); } },
      { id: "brand", label: "Brand colors and fonts / style guide", from: function (a, f) { return has(a, "brand_colors") || nfiles(f, "brand_guide") > 0; } },
      { id: "testimonials", label: "Testimonials and reviews", note: "screenshots or text", from: function (a, f) { return has(a, "testimonials") || nfiles(f, "reviews") > 0; } },
      { id: "headshots", label: "Owner or team headshots", from: function (a, f) { return nfiles(f, "headshots") > 0; } },
      { id: "badges", label: "Licenses, insurance, certifications, awards", note: "trust badges", from: function (a, f) { return nfiles(f, "badges") > 0; } },
      { id: "before_after", label: "Before/after photos", note: "if relevant", from: function (a, f) { return nfiles(f, "before_after") > 0; } }
    ]},
    { id: "info", title: "Business Info", items: [
      { id: "basics", label: "Legal name, phone, email, address, hours", from: function (a) { return has(a, "business_name") && has(a, "business_phone"); } },
      { id: "service_area", label: "Service area", note: "towns or counties", from: function (a) { return has(a, "service_area"); } },
      { id: "license_numbers", label: "License numbers", note: "if the trade requires them", from: function (a) { return has(a, "license_number"); } },
      { id: "review_links", label: "Google Business Profile, Google reviews, Yelp/Angi/HomeAdvisor links", from: function (a) { return has(a, "google_business") || has(a, "google_reviews_link") || has(a, "other_review_sites"); } }
    ]},
    { id: "urls", title: "URLs", items: [
      { id: "instagram", label: "Instagram", from: function (a) { return has(a, "instagram"); } },
      { id: "facebook", label: "Facebook", from: function (a) { return has(a, "facebook"); } },
      { id: "tiktok", label: "TikTok", from: function (a) { return has(a, "tiktok"); } },
      { id: "x", label: "X", from: function (a) { return has(a, "x"); } },
      { id: "linkedin", label: "LinkedIn", from: function (a) { return has(a, "linkedin"); } },
      { id: "pinterest", label: "Pinterest", from: function (a) { return has(a, "pinterest"); } },
      { id: "other_social", label: "Other social links", from: function (a) { return has(a, "youtube") || has(a, "other_links"); } },
      { id: "booking", label: "Booking calendar link", note: "optional", from: function (a) { return has(a, "booking_link"); } }
    ]},
    { id: "access", title: "Access / Accounts", items: [
      { id: "dns", label: "Domain registrar login or DNS access" },
      { id: "existing_site", label: "Existing site login", note: "to pull content, set redirects", from: function (a) { return has(a, "current_website") || has(a, "lp_website_url"); } },
      { id: "tracking", label: "Meta Pixel ID, GA4, Google Search Console" }
    ]},
    { id: "content", title: "Website Content", items: [
      { id: "loading_anim", label: "Loading animation" },
      { id: "main_anim", label: "Main site animation", note: "optional, recommended" },
      { id: "offerings", label: "Highlighted offerings", from: function (a) { return has(a, "service_1"); } },
      { id: "copy", label: "Website copy" },
      { id: "contact_form", label: "Contact form", note: "responses sent to email", from: function (a) { return has(a, "leads_email"); } }
    ]}
  ];

  var STAGES = [
    { id: "build", label: "New Lead – Build Phase" },
    { id: "seen", label: "Lead Has Seen Site" },
    { id: "closed", label: "Closed" },
    { id: "not_closed", label: "Not Closed" }
  ];

  function allFields() {
    var out = [];
    SECTIONS.forEach(function (s) { s.fields.forEach(function (f) { out.push(f); }); });
    return out;
  }

  root.SGS_SCHEMA = { SECTIONS: SECTIONS, FILE_KINDS: FILE_KINDS, CHECKLIST: CHECKLIST, STAGES: STAGES, allFields: allFields };
})(typeof window !== "undefined" ? window : globalThis);
