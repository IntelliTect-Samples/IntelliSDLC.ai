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
const fs = require('fs');
const os = require('os');
const path = require('path');

const pii = require(path.join(__dirname, 'pii.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));

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

    // `addr` / `addr1` / `addr2` is the older convention and was missing, so a
    // street address under that key shipped unscrubbed. A miss rather than a
    // corruption -- the acceptable direction -- but a real gap.
    for (const key of ['addr', 'addr1', 'addr2', 'billing_addr', 'shipping_addr_2']) {
        check(key, 'street-address', '6.c');
    }
}

// --- 7. A qualified location tail matches. ---
// The first version of this test asserted "there is no `bucket_city`" and
// treated `city` as unambiguous on that basis. That was an assumption written
// down as a premise rather than tested, and it was wrong -- see 7d.
{
    for (const key of ['billing_city', 'shipping_city', 'home_city', 'work_city',
        'origin_city', 'destination_city']) {
        check(key, 'city', '7.a');
    }
    for (const key of ['birth_date', 'date_of_birth', 'birthday']) {
        check(key, 'dob', '7.c');
    }
}

// --- 7d. `city` is a sorting and filtering word too. ---
// `sort_city: "asc"` was scrubbed to `sort_city: "Ashendell"`. A sort direction
// silently became a fake place name in a committed reference, with nothing
// reporting it -- the artifact corrupted rather than leaked from.
//
// This is the SAME class the qualifier allowlist already fixed for `region`,
// `country` and `zip`. `city`, `town` and `locality` were left in the
// unconditional bucket because the fix was applied to the three names that had
// been named, rather than to the category. List-endpoint verbs are exactly
// where a location word turns up meaning something else.
{
    for (const key of ['sort_city', 'filter_city', 'search_city', 'nearest_city',
        'sort_town', 'filter_locality', 'group_by_city', 'order_by_city']) {
        check(key, null, '7d.a');
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

// --- 7e. The rest of the unconditional set: dob and geo. ---
// Two rounds of review found this class twice -- `region`/`country`/`zip`,
// then `city`/`town`/`locality` -- and both times the fix went to the names
// that had been named. These are the remainder of the set.
//
// `birthday` is an anniversary word: an account, a page or a cohort has one and
// none of them is a person's date of birth. `latitude` and `longitude` are
// coordinate words: ecliptic and galactic coordinates are astronomy, and a
// game world grid reuses the same terms. Scrubbing any of them overwrites real
// data with a fake date or a zero.
{
    for (const key of ['account_birthday', 'page_birthday', 'cohort_birthday',
        'company_birthday', 'product_birthday']) {
        check(key, null, '7e.a');
    }
    for (const key of ['ecliptic_latitude', 'galactic_longitude', 'world_latitude',
        'grid_longitude', 'texture_latitude']) {
        check(key, null, '7e.b');
    }

    // ...and the person-located spellings still match.
    for (const key of ['user_birthday', 'customer_birthday', 'birth_date', 'date_of_birth']) {
        check(key, 'dob', '7e.c');
    }
    for (const key of ['device_latitude', 'gps_latitude', 'user_latitude', 'current_latitude']) {
        check(key, 'geo-lat', '7e.d');
    }
    for (const key of ['device_longitude', 'gps_longitude', 'user_longitude']) {
        check(key, 'geo-lng', '7e.e');
    }
}

// --- 7f. Qualifiers that a payments or travel payload actually uses. ---
// The mirror direction. `cardholder_name` sits directly beside card data in
// every checkout payload there is, and returned null. A miss is the acceptable
// direction, but not one worth accepting when the word is this common.
{
    for (const key of ['cardholder_name', 'beneficiary_name', 'payee_name', 'guardian_name',
        'spouse_name', 'traveler_name', 'passenger_name', 'applicant_name', 'tenant_name']) {
        check(key, 'person-name', '7f.a');
    }
    for (const key of ['invoice_city', 'invoice_address', 'cardholder_address']) {
        assert.ok(['city', 'street-address'].includes(pii.fieldType(key)),
            `7f.b: ${key} was not recognised as a location field`);
    }
}

// --- 7g. The last two of the unconditional set: phone and device-id. ---
// Third round on this category, so this closes it rather than narrowing it
// again. `isMobile` and `hasIdfa` are boolean flags, not fields carrying a
// number or an advertising id. The blast radius is smaller than the earlier
// members -- a misclassification only corrupts when the VALUE is also
// digit-shaped or UUID-shaped -- but "smaller" is not "closed", and a build
// string under `deviceMobile` or a trace id under `requestIdfa` is exactly the
// coincidence that finds it.
{
    for (const key of ['isMobile', 'deviceMobile', 'hasMobile', 'supportsMobile',
        'hasIdfa', 'isGaid', 'allowAdvertisingId', 'canTrackAdvertisingId']) {
        check(key, null, '7g.a');
    }

    // ...and the real ones still match.
    for (const key of ['phone', 'phone_number', 'home_phone', 'work_phone', 'contact_phone',
        'mobile', 'customer_mobile']) {
        check(key, 'phone', '7g.b');
    }
    for (const key of ['idfa', 'gaid', 'advertising_id', 'device_advertising_id', 'google_advertising_id']) {
        check(key, 'device-id', '7g.c');
    }
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

// --- 9b. No PII type may take an unqualified tail. ---
// Three review rounds each found the same defect in a different member of the
// `qualifiers: "any"` set -- region/country/zip, then city/town/locality, then
// dob/geo/phone/device-id. Every round fixed the members it had been shown.
//
// So this stops being about members. A tail word that matches behind ANY
// qualifier is a predicate standing in for a concept, on a path that REPLACES
// values, and every such tail has turned out to have a non-PII reading in real
// APIs. The setting still exists in the loader for a consuming project that
// genuinely wants it; the shipped default may not use it, and this is what
// says so out loud rather than leaving it true by accident.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-any-'));
    const policy = policyModule.loadPolicy({ startDir: dir, stopAt: dir });
    const unqualified = Object.keys(policy.piiFields)
        .filter((t) => policy.piiFields[t].tail.length > 0 && policy.piiFields[t].qualifiers === 'any');
    assert.deepStrictEqual(unqualified, [],
        `9b.a: ${unqualified.join(', ')} accept a tail behind any qualifier. Every type that has ` +
        'done so has turned out to have a non-PII reading -- aws_region, sort_city, ' +
        'account_birthday, ecliptic_latitude, isMobile. Give it an allowlist.');
    fs.rmSync(dir, { recursive: true, force: true });
}

// --- 10. The policy is what supplies the names. ---
// One document for the scrubber and both gates, so a project that renames a
// field does not have to patch a module constant.
{
    assert.ok(typeof pii.fieldTypeFor === 'function',
        '10.a: fieldType is not available in a policy-taking form, so a project cannot extend it');
}

console.log('All pii-fieldtype tests passed');
