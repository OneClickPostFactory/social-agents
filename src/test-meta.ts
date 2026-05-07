import * as https from 'node:https';

import config from '../config';

interface GraphError {
  message?: string;
}

interface GraphErrorContainer {
  error?: GraphError;
  raw?: string;
}

interface IdentityResponse extends GraphErrorContainer {
  id?: string;
  name?: string;
}

interface PageInfo {
  id: string;
  name: string;
  access_token?: string;
}

interface PagesResponse extends GraphErrorContainer {
  data?: PageInfo[];
}

interface InstagramBusinessAccount {
  id: string;
  username?: string;
  name?: string;
}

interface PageDetailResponse extends GraphErrorContainer {
  instagram_business_account?: InstagramBusinessAccount;
}

interface LinkedInstagramAccount extends InstagramBusinessAccount {
  pageId: string;
  pageName: string;
}

interface GroupResponse extends GraphErrorContainer {
  name?: string;
  privacy?: string;
}

interface InstagramAccountResponse extends GraphErrorContainer {
  id?: string;
  username?: string;
  name?: string;
}

interface ThreadsMeResponse extends GraphErrorContainer {
  id?: string;
  username?: string;
}

function get<T extends GraphErrorContainer>(hostname: string, pathname: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path: pathname, headers: { Accept: 'application/json' } }, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          resolve({ raw: data } as T);
        }
      });
    }).on('error', reject);
  });
}

async function main(): Promise<void> {
  const token = config.META_ACCESS_TOKEN;
  const threadsToken = config.THREADS_ACCESS_TOKEN;
  const graphVersion = config.META_GRAPH_VERSION;

  console.log('\n── Meta Token Test ──────────────────────────────');
  console.log(`Meta token configured: ${token ? 'yes' : 'no'}`);
  console.log(`Threads token present: ${threadsToken ? 'yes' : 'no'}`);
  console.log(`Graph versions: facebook=${graphVersion} threads=/me endpoints`);

  console.log('\n1. Identity check...');
  const me = await get<IdentityResponse>('graph.facebook.com', `/${graphVersion}/me?access_token=${token}`);
  console.log(me.error ? `   ✕ ${me.error.message}` : `   ✓ ${me.name} (${me.id})`);

  console.log('\n2. Facebook Pages...');
  const pages = await get<PagesResponse>(
    'graph.facebook.com',
    `/${graphVersion}/me/accounts?fields=id,name,access_token&access_token=${token}`
  );
  if (pages.error) {
    console.log(`   ✕ ${pages.error.message}`);
  } else if (!pages.data?.length) {
    console.log('   ✕ No pages found');
  } else {
    pages.data.forEach(page => {
      const tokenNote = page.access_token ? ' | page token available' : '';
      console.log(`   ✓ Page: ${page.name} (${page.id})${tokenNote}`);
    });
  }

  console.log('\n3. Page-linked Instagram accounts...');
  const linkedIgAccounts: LinkedInstagramAccount[] = [];
  if (pages.data?.length) {
    for (const page of pages.data) {
      const detail = await get<PageDetailResponse>(
        'graph.facebook.com',
        `/${graphVersion}/${page.id}?fields=instagram_business_account{id,username,name}&access_token=${token}`
      );

      if (detail.error) {
        console.log(`   ✕ ${page.name}: ${detail.error.message}`);
        continue;
      }

      const instagram = detail.instagram_business_account;
      if (!instagram?.id) {
        console.log(`   - ${page.name}: no linked instagram_business_account`);
        continue;
      }

      linkedIgAccounts.push({
        ...instagram,
        pageId: page.id,
        pageName: page.name,
      });
      console.log(
        `   ✓ ${page.name} → ${instagram.username ? '@' + instagram.username : 'Instagram account'} (${instagram.id})`
      );
    }
  }

  console.log('\n4. Facebook Group access...');
  const groupId = config.FACEBOOK_GROUP_ID;
  if (!groupId) {
    console.log('   ✕ FACEBOOK_GROUP_ID not set in .env');
  } else {
    const group = await get<GroupResponse>(
      'graph.facebook.com',
      `/${graphVersion}/${groupId}?fields=name,privacy&access_token=${token}`
    );
    if (group.error) {
      console.log(`   ✕ ${group.error.message}`);
      console.log('     The app cannot post to this group until the token can read the group object.');
    } else {
      console.log(`   ✓ Group: ${group.name} (${group.privacy})`);
    }
  }

  console.log('\n5. Configured Instagram account...');
  const igId = config.INSTAGRAM_ACCOUNT_ID;
  if (!igId) {
    const configuredPage = pages.data?.find(page => page.id === config.FACEBOOK_PAGE_ID);
    if (linkedIgAccounts.length && configuredPage) {
      console.log(
        `   ✓ INSTAGRAM_ACCOUNT_ID not set, but it can be auto-discovered from FACEBOOK_PAGE_ID ${configuredPage.id}`
      );
    } else if (linkedIgAccounts.length && config.FACEBOOK_PAGE_ID) {
      const discoveredPages = linkedIgAccounts.map(account => account.pageId).join(', ');
      console.log(
        `   ✕ INSTAGRAM_ACCOUNT_ID not set, and FACEBOOK_PAGE_ID ${config.FACEBOOK_PAGE_ID} does not match the Page(s) currently linked to Instagram: ${discoveredPages}`
      );
    } else if (config.FACEBOOK_PAGE_ID) {
      console.log(
        '   ✕ INSTAGRAM_ACCOUNT_ID not set in .env and no page-linked instagram_business_account is available yet'
      );
    } else {
      console.log('   ✕ INSTAGRAM_ACCOUNT_ID not set in .env');
    }
  } else {
    const linkedMatch = linkedIgAccounts.find(account => account.id === igId);
    if (linkedMatch) {
      console.log(
        `   ✓ Matches page-linked Instagram for ${linkedMatch.pageName}` +
        `${linkedMatch.username ? ` (@${linkedMatch.username})` : ''}`
      );
    } else {
      const instagram = await get<InstagramAccountResponse>(
        'graph.facebook.com',
        `/${graphVersion}/${igId}?fields=id,username,name&access_token=${token}`
      );

      if (instagram.error) {
        console.log(`   ✕ ${instagram.error.message}`);
      } else {
        console.log(`   ✓ Instagram: ${instagram.username ? '@' + instagram.username : instagram.name || instagram.id} (${instagram.id})`);
      }

      if (me.id && igId === me.id) {
        console.log('     This matches your Facebook user ID, not a page-linked Instagram account ID.');
      }

      if (linkedIgAccounts.length) {
        console.log('     Suggested INSTAGRAM_ACCOUNT_ID values from your pages:');
        linkedIgAccounts.forEach(account => {
          console.log(
            `       - ${account.id} (${account.pageName}${account.username ? ` → @${account.username}` : ''})`
          );
        });
      } else {
        console.log('     No linked instagram_business_account was discovered from your pages.');
      }
    }
  }

  if (config.FACEBOOK_PAGE_ACCESS_TOKEN) {
    console.log('\n   Note: FACEBOOK_PAGE_ACCESS_TOKEN is set in .env');
  } else if (pages.data?.some(page => page.id === config.FACEBOOK_PAGE_ID && page.access_token)) {
    console.log('\n   Note: FACEBOOK_PAGE_ACCESS_TOKEN is not set, but it can be auto-derived from your configured Page');
  }

  console.log('\n6. Threads account...');
  const threadsMe = await get<ThreadsMeResponse>(
    'graph.threads.net',
    `/me?fields=id,username&access_token=${threadsToken}`
  );
  if (threadsMe.error) {
    console.log(`   ✕ ${threadsMe.error.message}`);
  } else {
    console.log(`   ✓ Threads account: ${threadsMe.id}${threadsMe.username ? ` (@${threadsMe.username})` : ''}`);
    if (!config.THREADS_USER_ID) {
      console.log(`     THREADS_USER_ID is not set. Suggested value: ${threadsMe.id}`);
    } else if (config.THREADS_USER_ID !== threadsMe.id) {
      console.log(`     THREADS_USER_ID does not match /me. Suggested value: ${threadsMe.id}`);
    }
  }

  if (config.FACEBOOK_USER_ID && me.id && config.FACEBOOK_USER_ID !== me.id) {
    console.log(`   Note: FACEBOOK_USER_ID in .env does not match /me. Suggested value: ${me.id}`);
  }

  if (config.FACEBOOK_PAGE_ID && pages.data?.[0] && config.FACEBOOK_PAGE_ID !== pages.data[0].id) {
    console.log(`   Note: FACEBOOK_PAGE_ID in .env does not match the discovered Page ID ${pages.data[0].id}`);
  }

  console.log('\n────────────────────────────────────────────────\n');
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Test error:', message);
});
