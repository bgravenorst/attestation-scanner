import { ethers } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
import axios from "axios";

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
          { "internalType": "bytes",   "name": "subject",       "type": "bytes" },
          { "internalType": "bytes",   "name": "attestationData","type": "bytes" }
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

// === FUNCTION: Decode the attestation data which exists in attestationData ===
function decodeAttestationData(encodedData) {
  if (!encodedData || encodedData === "0x") {
    console.warn("⚠️ Skipping empty attestation data.");
    return null;
  }
//  console.log("🔍 Encoded Attestation Data (Hex):", encodedData);
  try {
    const decoded = ethers.utils.defaultAbiCoder.decode(
      ["bool", "string", "address"],
      encodedData
    );
    // decoded is an array: [ isPositive, articlePage, submitter ]
    const [isPositive, articlePage, submitter] = decoded;
    console.log("✅ Decoded with Ethers:", { isPositive, articlePage, submitter });
    return { isPositive, articlePage, submitter };
  } catch (error) {
    console.error("❌ Error decoding with Ethers:", error.message);
    return null;
  }
}

// === FUNCTION: Parse a 32-byte subject into a valid address ===
function parseSubjectAsAddress(subjectBytes) {
  // If subject is 32 bytes (0x + 64 hex chars), extract the last 20 bytes.
  if (subjectBytes.length === 66) {
    const last40 = subjectBytes.slice(-40);
    return ethers.utils.getAddress("0x" + last40);
  } else {
    return ethers.utils.getAddress(subjectBytes);
  }
}

// === FUNCTION: Initialize New JSON and CSV File each run ===
const initializeFiles = () => {
  fs.writeFileSync(JSON_FILE, "", "utf8");
  fs.writeFileSync(
    CSV_FILE,
    "txHash,blockNumber,from,timestamp,articlePage,positiveFeedback,negativeFeedback\n",
    "utf8"
  );
};

// Save Attestation to JSON
const saveToJSON = (attestation) => {
  const jsonString = JSON.stringify(attestation, null, 2) + "\n";
  fs.appendFileSync(JSON_FILE, jsonString, "utf8");
};

// Save Attestation to CSV
const saveToCSV = (attestation) => {
  const isPositive = String(attestation.isPositive);
  const articlePage = String(attestation.articlePage);
  const submitter = String(attestation.submitter);
  const csvLine = `${attestation.txHash},${attestation.blockNumber},${attestation.from},${attestation.timestamp},${attestation.articlePage},${attestation.positiveFeedback},${attestation.negativeFeedback}\n`;
  fs.appendFileSync(CSV_FILE, csvLine, "utf8");
};

// === FUNCTION: Decode a single Attestation from a transaction ===
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
//    console.log(`🔍 Decoded transaction data for ${txHash}:`, decoded);

    const [attestationPayload, validationPayloads] = decoded.args;
//    console.log("🔍 Extracted Attestation Payload:", attestationPayload);
    if (!attestationPayload || Object.keys(attestationPayload).length === 0) {
      console.error("❌ Error: attestationPayload is empty or undefined.");
      return;
    }

    const schemaId = attestationPayload.schemaId;
    const rawSubject = attestationPayload.subject;
    const attestationDataEncoded = attestationPayload.attestationData;
//    console.log("🔍 Raw Attestation Data (Encoded):", attestationDataEncoded);

    let decodedAttestationData = decodeAttestationData(attestationDataEncoded);
    if (!decodedAttestationData) {
      console.error("❌ Error: Decoded attestation data is null.");
      return;
    }

    // Parse subject address from 32-byte value.
    let subjectAddress;
    try {
      subjectAddress = parseSubjectAsAddress(rawSubject);
    } catch (err) {
      console.error("Invalid subject address:", err);
      return;
    }

    // Fetch block to get its timestamp.
    const block = await provider.getBlock(blockNumber);
    const blockTimestamp = new Date(block.timestamp * 1000).toISOString();

    const attestation = {
      txHash,
      blockNumber,
      from: decodedAttestationData.submitter,
      timestamp: blockTimestamp,
      articlePage: decodedAttestationData.articlePage,
      positiveFeedback: decodedAttestationData.isPositive ? 1 : 0,
      negativeFeedback: decodedAttestationData.isPositive ? 0 : 1,
    };

    console.log("📜 Attestation Found:", attestation);
    saveToJSON(attestation);
    saveToCSV(attestation);
  } catch (error) {
    console.error(`❌ Error decoding transaction ${txHash}:`, error);
  }
};

// === FUNCTION: Fetch Transactions from LineaScan API ===
const fetchTransactionsFromExplorer = async () => {
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
        decodeAttestation(tx.hash, parseInt(tx.blockNumber));
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
    const blockWithTx = await provider.getBlockWithTransactions(blockNumber);
    for (const tx of blockWithTx.transactions) {
      if (tx.to && tx.to.toLowerCase() === CONTRACT_ADDRESS) {
        decodeAttestation(tx.hash, blockNumber);
      }
    }
  });
};

// === STARTUP SEQUENCE ===
(async () => {
  console.log("🚀 Attestation monitoring service starting...");
  // Create new JSON & CSV files for each run.
  initializeFiles();
  // 1) Fetch historical data from LineaScan Explorer.
  await fetchTransactionsFromExplorer();
  // 2) Optional: Start real-time monitoring.
  // subscribeToNewBlocks();
})();
