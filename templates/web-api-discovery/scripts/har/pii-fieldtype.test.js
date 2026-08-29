#!/usr/bin/env node
// Behavior tests for PII field-name matching (issue #297, Stage 6, Task 6.2).
//
// Zero-dep, runs with `node pii-fieldtype.test.js`.
//
// `fieldType()` did `FIELD[t].has(key.toLowerCase())` -- an EXACT match, while
// its own comment claimed to "match on JSON key tail". So `firstname` matched
// and `first_name`, `billing_city`, `date_of_birth` all missed, in APIs where
// snake_case is the dominant convention. The issue calls this the likely
// largest source of unscrubbed PII today.
//
// The fix is not simply "match the tail", because `fieldType` does not report
// a value -- it REPLACES it. Every false positive corrupts the payload the
// reference exists to document, which is the same failure that made the old
// gate unusable, relocated from detection into scrubbing. So the tail rules
// are written to fail toward MISSING a field rather than toward destroying
// one, and the second control (the literal pass over `.har-profile.json`)
// covers what a name list cannot know about.

'use strict';

const assert = require('assert');
const path = require('path');

const pii = require(path.join(__dirname, 'pii.js'));

function check(key, expected, label) {
    assert.strictEqual(pii.fieldType(key), expected,
        `${label}: fieldType(${JSON.stringify(key)}) => ${JSON.stringify(pii.fieldType(key))}, expected ${JSON.stringify(expected)}`);
}

// --- 1. The exact names that worked before still work. ---
{
    for (const key of ['name', 'firstname', 'lastname', 'fullname', 'displayname', 'surname']) {
        check(key, 'person-name', '1.a');
    }
    check('city', 'city', '1.b');
    check('postalcode', 'postal-code', '1.c');
    check('dob', 'dob', '1.d');
    check('country', 'country', '1.e');
}

// --- 2. Separator-delimited keys now match. Task 6.1's list, verbatim. ---
{
    check('first_name', 'person-name', '2.a');
    check('user_name', 'person-name', '2.b');
    check('billing_city', 'city', '2.c');
    check('shipping_address_1', 'street-address', '2.d');
    check('date_of_birth', 'dob', '2.e');
}

// --- 3. Every separator convention an API might use. ---
{
    check('first-name', 'person-name', '3.a');
    check('firstName', 'person-name', '3.b');
    check('FirstName', 'person-name', '3.c');
    check('billing.city', 'city', '3.d');
    check('BILLING_CITY', 'city', '3.e');
    check('shippingPostalCode', 'postal-code', '3.f');
}

// --- 4. A tail token is a TOKEN, never a substring. ---
// This is what makes the rule safe at all: `capacity` does not end with the
// token `city`, and `surname` is one token, not `sur` + `name`.
{
    check('capacity', null, '4.a');
    check('velocity', null, '4.b');
    check('rename', null, '4.c');
    check('domain', null, '4.d');
    check('remaining', null, '4.e');
}

// --- 5. `name` is qualified, because most `*_name` fields are not people. ---
// A key ending in the token `name` is overwhelmingly NOT a person: file_name,
// event_name, class_name, host_name, bucket_name, column_name. Scrubbing those
// replaces a filename with `Avery Brooks` and corrupts the capture in a way no
// reader can detect afterwards.
//
// So the qualifier is an ALLOWLIST, not a denylist of things that are not
// people. A denylist fails open -- every convention nobody thought of becomes
// a corrupted field -- while an allowlist fails toward a miss, which the
// literal pass still covers.
{
    for (const key of ['file_name', 'fileName', 'event_name', 'class_name', 'host_name',
        'bucket_name', 'column_name', 'table_name', 'field_name', 'tag_name',
        'product_name', 'service_name', 'app_name', 'folder_name', 'image_name',
        'node_name', 'font_name', 'icon_name', 'method_name', 'operation_name']) {
        check(key, null, '5.a');
    }

    // ...while the person-ish qualifiers do match.
    for (const key of ['first_name', 'last_name', 'full_name', 'given_name', 'family_name',
        'middle_name', 'preferred_name', 'legal_name', 'display_name', 'user_name',
        'screen_name', 'nick_name', 'contact_name', 'customer_name', 'owner_name',
        'recipient_name', 'sender_name', 'author_name', 'member_name', 'account_name']) {
        check(key, 'person-name', '5.b');
    }
}

// --- 6. `address` is qualified too, and for a sharper reason. ---
// `ip_address`, `mac_address` and `email_address` all end in the token
// `address` and none is a street. Matching them as `street-address` would not
// merely over-scrub: it would replace an IP with `42 Cedar Lane`, mislabel the
// finding, and hand the operator a substitution that makes no sense.
{
    for (const key of ['ip_address', 'ipAddress', 'mac_address', 'email_address',
        'server_address', 'host_address', 'contract_address', 'wallet_address']) {
        assert.notStrictEqual(pii.fieldType(key), 'street-address',
            `6.a: ${key} was classified as a street address`);
    }

    for (const key of ['address', 'street_address', 'billing_address', 'shipping_address',
        'mailing_address', 'home_address', 'delivery_address', 'address_line_1',
        'shipping_address_1', 'street']) {
        check(key, 'street-address', '6.b');
    }
}

// --- 7. Genuinely unambiguous tails need no qualifier. ---
// `city`, `town`, `locality` and the date-of-birth spellings carry their
// meaning in the token itself: there is no `bucket_city` or `file_dob`.
{
    for (const key of ['billing_city', 'shipping_city', 'home_city', 'work_city']) {
        check(key, 'city', '7.a');
    }
    for (const key of ['birth_date', 'date_of_birth', 'birthday']) {
        check(key, 'dob', '7.c');
    }
}

// --- 7b. `region`, `country` and `zip` are NOT unambiguous. ---
// The first draft of this policy put them in the no-qualifier bucket on the
// reasoning that the token speaks for itself. It does not: `region`, `country`
// and `zip` are among the most common words in infrastructure, locale and file
// handling, and none of those uses is a person's location.
//
// The consequence is worse than a noisy report, because this drives a SCRUB:
// `aws_region: "us-east-1"` becomes a fake two-letter code, `backup_zip:
// "nightly.zip"` becomes a five-digit number, and the reference is corrupted
// in a way that still looks like valid data.
{
    for (const key of ['aws_region', 'deploy_region', 'cluster_region', 'storage_region',
        'data_region', 'service_region', 'content_region', 'market_region']) {
        check(key, null, '7b.a');
    }
    for (const key of ['locale_country', 'site_country', 'market_country', 'currency_country',
        'manufacture_country', 'origin_country', 'tax_country', 'vat_country']) {
        check(key, null, '7b.b');
    }
    for (const key of ['backup_zip', 'export_zip', 'attachment_zip', 'file_zip']) {
        check(key, null, '7b.c');
    }

    // ...while the person-located spellings still match.
    for (const key of ['home_region', 'billing_region', 'shipping_province']) {
        check(key, 'region', '7b.d');
    }
    for (const key of ['billing_country', 'shipping_country', 'home_country']) {
        check(key, 'country', '7b.e');
    }
    for (const key of ['billing_postal_code', 'shipping_zip', 'home_postcode', 'mailing_zip_code']) {
        check(key, 'postal-code', '7b.f');
    }
}

// --- 7c. A tail word never matches unqualified just because it stands alone. ---
// The first implementation returned a match whenever the tail started at word
// zero, skipping the qualifier allowlist entirely. It was invisible only
// because every tail token also happened to be an `exact` name -- and nothing
// enforces that, while the policy merge explicitly lets a project append a
// tail word on its own. The next person to do so would have got unconditional
// scrubbing of that bare key, which is the precise hole the allowlist exists
// to close.
{
    const policy = {
        piiFields: {
            'person-name': { exact: ['name'], tail: ['name', 'moniker'], qualifiers: ['first', 'last'] },
        },
    };
    assert.strictEqual(pii.fieldTypeFor('moniker', policy), null,
        '7c.a: a tail-only word matched a bare key without passing the qualifier allowlist');
    assert.strictEqual(pii.fieldTypeFor('bucket_moniker', policy), null,
        '7c.b: a tail-only word matched behind a non-qualifying prefix');
    assert.strictEqual(pii.fieldTypeFor('first_moniker', policy), 'person-name',
        '7c.c: a qualified tail-only word stopped matching');
    assert.strictEqual(pii.fieldTypeFor('name', policy), 'person-name',
        '7c.d: a bare key listed in `exact` stopped matching');
}

// --- 8. A trailing index is part of the path, not part of the name. ---
// `address_line_1`, `addresses[0]`, `phone_2` -- an ordinal suffix is how APIs
// spell repetition, and it must not stop the field being recognised.
{
    check('address_1', 'street-address', '8.a');
    check('address_line_2', 'street-address', '8.b');
    check('first_name_1', 'person-name', '8.c');
}

// --- 9. Non-strings and empty keys are not fields. ---
{
    for (const key of [null, undefined, 42, '', '_', '__', '---']) {
        assert.strictEqual(pii.fieldType(key), null, `9.a: fieldType(${JSON.stringify(key)}) matched something`);
    }
}

// --- 10. The policy is what supplies the names. ---
// One document for the scrubber and both gates, so a project that renames a
// field does not have to patch a module constant.
{
    assert.ok(typeof pii.fieldTypeFor === 'function',
        '10.a: fieldType is not available in a policy-taking form, so a project cannot extend it');
}

console.log('All pii-fieldtype tests passed');
