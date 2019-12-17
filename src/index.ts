///<reference path="./index.d.ts" />

import express from 'express';
import morgan from 'morgan';
import asyncHandler from 'express-async-handler';

import { Cluster } from 'puppeteer-cluster';

import * as Url from 'url';
import { Page } from 'puppeteer';

let cluster: Cluster;
const cache: {
    email: { [url: string]: string[] },
    urls: { [url: string]: string[] },
} = { email: {}, urls: {} }; // TODO: redis

const app = express();

app.use(morgan('tiny'));


app.get(`/getEmail`, asyncHandler(async (req, res) => {
    const { url } = req.query;
    try {
        const emails = await getEmails(url);
        res.send(emails);
    } catch (err) {
        res.status(500).send(err);
    }
}));

app.get(`/getUrls`, asyncHandler(async (req, res) => {
    const { url, selector } = req.query;
    try {
        const urls = await cluster.execute({ url, selector, mode: 'urls' });
        res.send(urls);
    } catch (err) {
        res.status(500).send(err);
    }
}));



async function urlsTask({ page, data: { url, selector } }: { page: Page, data: any }) {
    if (cache.urls[url]) {
        console.info(`Cache hit for [${url}]`);
        return cache.urls[url];
    }

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const hrefs: string[] = await page.$$eval(selector, (els) => {
        return els.map(a => a.getAttribute('href'));
    }) as any;

    return hrefs
        .map(a => a.trim())
        .filter(a => a)
        .map(href => Url.resolve(url, href));
}


async function emailTask({ page, data: { url, scrapedUrls } }: { page: Page, data: any }) {
    if (cache.email[url]) {
        console.info(`Cache hit for [${url}]`);
        return cache.email[url];
    }

    console.info(`Extracting emails from [${url}]`);
    const { hostname } = Url.parse(url);
    const strippedDomain = hostname!.replace('www.', '').replace('.co.uk', '').replace('.com', ''); // TODO: better
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        // const emails: string[] = await page.$$eval(`[href*="mailto:"]`, (els) => {
        //     return els.map(a => a.getAttribute('href')!.replace('mailto:', '').split('?')[0]);
        // }) as any;

        const emails = await page.$eval('body', (body) => {
            function getEmailFromStr(str: string): string[] {
                if (!str.length) return [];
                const index = str.indexOf('@');
                const lookAt = str.slice(index - 100, index + 100);
                const parts = lookAt.split(/[\s]/g);
                const emailIndex = parts.findIndex(p => p.includes('@'));
                if (emailIndex === -1) return [];
                const emailStr = parts[emailIndex];
                const emailLeftFull = emailStr.split('@')[0];
                const emailRightFull = emailStr.split('@')[1];
                const emailLeftClean = emailLeftFull.split(/[^\.0-9A-z_-]/g).slice(-1)[0];
                const emailRightClean = emailRightFull.split(/[^\.0-9A-z_-]/g)[0];

                if (!emailLeftClean) return [];
                const email = emailLeftClean + '@' + emailRightClean;

                const nextStr = str.slice(index);
                return [email].concat(
                    getEmailFromStr(nextStr),
                );
            }
            return getEmailFromStr(body.innerHTML);
        }) as any;

        const contactHintSelectors = contactHints.map(hint => {
            return `[href*="${hint}"]:not([href*="mailto:"])`;
        });

        const possibleContactUrls: string[] = (await page.$$eval(contactHintSelectors.join(','), (as) => {
            return as.map(a => a.getAttribute('href')!);
        }) as any)
            .map((href: string) => Url.resolve(url, href))
            .sort()
            .filter((href: string) => !href.startsWith('http') || href.includes(strippedDomain))
            .filter((val: string, i: number, arr: string[]) => val != arr[i + 1]);

        let extraEmails: string[] = [];
        if (possibleContactUrls.length && !scrapedUrls.length) {
            extraEmails = (await Promise.all(
                possibleContactUrls.map(url => getEmails(url, possibleContactUrls))
            )).flat();
        }
        const ret = (emails as string[])
            .concat(extraEmails)
            .map(a => a.trim())
            .filter(a => a)
            .sort()
            .filter((val, i, arr) => val != arr[i + 1]);
        cache.email[url] = ret;
        console.log(`Done scraping [${url}]`);
        return ret;
    } catch (err) {
        console.error(`Error when scraping [${url}]`, err);
        return [];
    }
}

async function start() {
    cluster = await Cluster.launch({
        concurrency: Cluster.CONCURRENCY_PAGE,
        maxConcurrency: 10,
        puppeteerOptions: {
            // headless: false,
            args: ['--no-sandbox'],
        }
    });

    cluster.task(async (opts) => {
        if (opts.data.mode === 'email') {
            return emailTask(opts)
        } else if (opts.data.mode === 'urls') {
            return urlsTask(opts);
        } else {
            console.error(`Couldn't find mode [${opts.data.mode}]`);
        }
    });

    app.listen(12180, () => {
        console.info(`Listening on port [${12180}]`);
    });
}


start()
    .then(
        () => console.log(`App Started`),
        (err) => console.error(`Failed to start app`, err)
    );


const contactHints = ['/contact', '/about'];

async function getEmails(url: string, scrapedUrls: string[] = []): Promise<string[]> {
    return await cluster.execute({ url, scrapedUrls, mode: 'email' });
}
