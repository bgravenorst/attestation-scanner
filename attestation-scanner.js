import { ethers } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
import axios from "axios";
import { decodeAbiParameters, parseAbiParameters } from "viem"; // Import Viem

dotenv.config();

// === CONFIGURATION ===
const INFURA_HTTPS = `https://linea-sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`;
const provider = new ethers.providers.JsonRpcProvider(INFURA_HTTPS);

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS.toLowerCase();
const LINEASCAN_API_KEY = process.env.LINEASCAN_API_KEY;
const LINEASCAN_API_URL = `https://api-sepolia.lineascan.build/api`;
const LINEASCAN_TX_API = `${LINEASCAN_API_URL}?module=account&action=txlist&address=${CONTRACT_ADDRESS}&startblock=0&endblock=99999999&sort=desc&page=1&offset=100&apikey=${LINEASCAN_API_KEY}`;

// === FILE PATHS ===
const JSON_FILE = "./attestations.json";
const CSV_FILE = "./attestations.csv";

// === CONTRACT ABI ===
const ABI = [
    {
        "inputs": [
            {
                "components": [
                    { "internalType": "bytes32", "name": "schemaId", "type": "bytes32" },
                    { "internalType": "uint64", "name": "expirationDate", "type": "uint64" },
                    { "internalType": "bytes", "name": "subject", "type": "bytes" },
                    { "internalType": "bytes", "name": "attestationData", "type": "bytes" }
                ],
                "internalType": "struct AttestationPayload",
                "name": "attestationPayload",
                "type": "tuple"
            },
            { "internalType": "bytes[]", "name": "validationPayloads", "type": "bytes[]" }
        ],
        "name": "attest",
        "outputs": [],
        "stateMutability": "payable",
        "type": "function"
    }

];
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

// Viem Schema for Attestation Data Decoding
const attestationDataSchema = "(bool isPositive, string articlePage, address submitter)";

// === FUNCTION: Decode the attestation data which exists in attestationData ===
function decodeAttestationData(encodedData) {
    try {
        if (!encodedData || encodedData === "0x") {
            console.warn("⚠️ Skipping empty attestation data.");
            return null;
        }

        console.log("🔍 Encoded Attestation Data (Hex):", encodedData);

        // Decode using Viem
        const decodedArray = decodeAbiParameters(parseAbiParameters(attestationDataSchema), encodedData);

        console.log("✅ Decoded Data in function decodeAttestationData:", decodedArray);

        // ✅ Extract the first object from the array
        if (Array.isArray(decodedArray) && decodedArray.length > 0) {
            const decodedData = decodedArray[0];

            return {
                isPositive: Boolean(decodedData.isPositive),  // Ensure boolean
                articlePage: decodedData.articlePage ?? "N/A", // Ensure string
                submitter: decodedData.submitter ?? "N/A"    // Ensure string
            };
        } else {
            console.error("❌ Error: Decoded data is not in expected format.");
            return null;
        }
    } catch (error) {
        console.error("❌ Error decoding attestation data:", error.message);
        return null;
    }
}




// === FUNCTION: Initialize New JSON and CSV File each run ===
const initializeFiles = () => {
    fs.writeFileSync(JSON_FILE, "", "utf8");
    fs.writeFileSync(CSV_FILE, "txHash,blockNumber,schemaId,subject,isPositive,articlePage,submitter,timestamp\n", "utf8"); // CSV headers
};

// Save Attestation to JSON
const saveToJSON = (attestation) => {
    // Convert attestation object to a JSON string, followed by a newline
    const jsonString = JSON.stringify(attestation, null, 2) + "\n";  
    fs.appendFileSync(JSON_FILE, jsonString, "utf8");
};


// Save attestation to CSV
const saveToCSV = (attestation) => {
    // Ensure values are properly formatted as strings
    const isPositive = String(attestation.isPositive);
    const articlePage = String(attestation.articlePage);
    const submitter = String(attestation.submitter);

    // Construct the CSV line properly
    const csvLine = `${attestation.txHash},${attestation.blockNumber},${attestation.schemaId},${attestation.subject},${isPositive},${articlePage},${submitter},${attestation.timestamp}\n`;

    // Append to the CSV file
    fs.appendFileSync(CSV_FILE, csvLine, "utf8");
};



// Decode Attestation is an asynchronous function (async) that interacts with the blockchain
// It fetches transaction data using await and processes attestations by sending it to decodeAttestationData.
const decodeAttestation = async (txHash, blockNumber) => {
    try {
        const tx = await provider.getTransaction(txHash);
        if (!tx || tx.to?.toLowerCase() !== CONTRACT_ADDRESS) {
            console.warn(`⚠️ Skipping non-matching transaction: ${txHash}`);
            return;
        }

        if (!tx.data || tx.data === "0x") {
            console.warn(`⚠️ Skipping transaction without input data: ${txHash}`);
            return;
        }

        const decoded = contract.interface.parseTransaction({ data: tx.data });
        if (!decoded || !decoded.args) {
            console.warn(`⚠️ Could not decode transaction: ${txHash}`);
            return;
        }

        console.log(`🔍 Decoded transaction data for ${txHash}:`, decoded);

        const [attestationPayload, validationPayloads] = decoded.args;
        console.log("🔍 Extracted Attestation Payload:", attestationPayload);

        if (!attestationPayload || Object.keys(attestationPayload).length === 0) {
            console.error("❌ Error: attestationPayload is empty or undefined.");
            return;
        }

        const schemaId = attestationPayload.schemaId;
        const subject = attestationPayload.subject;
        const attestationDataEncoded = attestationPayload.attestationData;

        console.log("🔍 Raw Attestation Data (Encoded):", attestationDataEncoded);

        let decodedAttestationData;
        try {
            decodedAttestationData = decodeAttestationData(attestationDataEncoded);
        } catch (decodeError) {
            console.error(`❌ Error decoding attestation data:`, decodeError.message);
            return;
        }

        // ✅ Ensure values are properly extracted
        if (!decodedAttestationData) {
            console.error("❌ Error: Decoded attestation data is null.");
            return;
        }

        const isPositive = decodedAttestationData.isPositive;
        const articlePage = decodedAttestationData.articlePage;
        const submitter = decodedAttestationData.submitter;
        
        const attestation = {
            txHash,
            blockNumber,
            schemaId,
            subject: ethers.utils.getAddress(subject),
            isPositive,
            articlePage,
            submitter,
            timestamp: new Date().toISOString()
        };

        console.log("📜 New Attestation Found:", attestation);

        saveToJSON(attestation);
        saveToCSV(attestation);

    } catch (error) {
        console.error(`❌ Error decoding transaction ${txHash}:`, error);
    }
};


// === FUNCTION: Fetch Transactions from LineaScan API ===
const fetchTransactionsFromExplorer = async (contract) => {
    try {
        console.log("🔍 Fetching transactions from LineaScan...");
        const response = await axios.get(LINEASCAN_TX_API);
        if (response.data.status !== "1") {
            console.error("❌ Error: LineaScan API returned an error:", response.data.message);
            return;
        }

        const transactions = response.data.result;

        for (const tx of transactions) {
            if (tx.to.toLowerCase() === CONTRACT_ADDRESS) {
                decodeAttestation(tx.hash, parseInt(tx.blockNumber), contract);
            }
        }
    } catch (error) {
        console.error("❌ Error fetching transactions from LineaScan:", error);
    }
};

// === FUNCTION: Subscribe to New Blocks via WebSocket ===
const subscribeToNewBlocks = () => {
    console.log("🔌 Subscribing to new blocks...");
    provider.on("block", async (blockNumber) => {
        console.log(`📡 New block detected: ${blockNumber}`);
        const blockData = await provider.getBlock(blockNumber, true); // 'true' includes transactions

        for (const tx of blockData.prefetchedTransactions) { // Access transactions using 'prefetchedTransactions'
            if (tx.to && tx.to.toLowerCase() === CONTRACT_ADDRESS) {
                decodeAttestation(tx.hash, blockNumber);
            }
        }
    });
};

// === STARTUP SEQUENCE ===
(async () => {
    console.log("🚀 Attestation monitoring service starting...");
    
    // **Ensure new JSON & CSV file is created on each run**
    initializeFiles();
    await fetchTransactionsFromExplorer(); // Fetch from LineaScan Explorer
    //subscribeToNewBlocks(); // Start real-time monitoring
})();
