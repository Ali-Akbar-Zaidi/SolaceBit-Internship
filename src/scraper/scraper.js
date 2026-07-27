import axios from "axios";
import * as cheerio from "cheerio";

/**
 * Scrapes a webpage and extracts:
 * - Title
 * - Headings (h1, h2, h3)
 * - Paragraphs
 */

export async function scrapeWebsite(url) {
    try {
        // Fetch the webpage
        const response = await axios.get(url);

        // Get raw HTML
        const html = response.data;

        // Load HTML into Cheerio
        const $ = cheerio.load(html);

        // Extract page title
        const title = $("title").text().trim();

        // Extract headings
        const headings = [];

        $("h1, h2, h3").each((index, element) => {
            const heading = $(element).text().trim();

            if (heading.length > 0) {
                headings.push(heading);
            }
        });

        // Extract paragraphs
        const paragraphs = [];

        $("p").each((index, element) => {
            const paragraph = $(element).text().trim();

            if (paragraph.length > 0) {
                paragraphs.push(paragraph);
            }
        });

        // Print results
        console.log("\n==============================");
        console.log("PAGE TITLE");
        console.log("==============================");
        console.log(title);

        console.log("\n==============================");
        console.log("HEADINGS");
        console.log("==============================");
        headings.forEach((heading, index) => {
            console.log(`${index + 1}. ${heading}`);
        });

        console.log("\n==============================");
        console.log("PARAGRAPHS");
        console.log("==============================");
        paragraphs.forEach((paragraph, index) => {
            console.log(`${index + 1}. ${paragraph}\n`);
        });

        // Return scraped data
        return {
            title,
            headings,
            paragraphs,
        };

    } catch (error) {
        console.error("Error scraping website:");
        console.error(error.message);
    }
}