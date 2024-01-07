"use strict";
const ethers = require("ethers");
const clear = require('clear');
const { Web3, Contract, WebSocketProvider } = require('web3');
const provider = new WebSocketProvider(
    "ws://localhost:8546",
    {},
    {
        delay: 500,
        autoReconnect: true,
        maxAttempts: 10,
    },
);
let web3 = new Web3(provider);
const pcs = '0x10ED43C718714eb63d5aA57B78B54704E256024E'.toLowerCase();
const pcsBuyAbi = new ethers.Interface(require("./pcsBuyAbi.json"));
const standardTokenAbi = [{
    "constant": false,
    "inputs": [{ "internalType": "address", "name": "spender", "type": "address" }, {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
    }],
    "name": "approve",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function"
}, {
    "constant": true,
    "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }, {
        "internalType": "address",
        "name": "spender",
        "type": "address"
    }],
    "name": "allowance",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
}, {
    "constant": true,
    "inputs": [{ "internalType": "address", "name": "account", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
}, {
    "constant": true,
    "inputs": [],
    "name": "decimals",
    "outputs": [{ "internalType": "uint8", "name": "", "type": "uint8" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
}, {
    "constant": true,
    "inputs": [],
    "name": "name",
    "outputs": [{ "internalType": "string", "name": "", "type": "string" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
}, {
    "constant": true,
    "inputs": [],
    "name": "symbol",
    "outputs": [{ "internalType": "string", "name": "", "type": "string" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
}, {
    "constant": false,
    "inputs": [{ "internalType": "address", "name": "recipient", "type": "address" }, {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
    }],
    "name": "transfer",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function"
}, {
    "inputs": [],
    "name": "owner",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
}];

web3.eth.handleRevert = true;
web3.eth.setMaxListenerWarningThreshold(50);
web3.setMaxListenerWarningThreshold(50);
web3.maxListenersWarningThreshold = 100;
web3.eth.maxListenersWarningThreshold = 100;



const swapExactETHForTokensSupportingFeeOnTransferTokens = new RegExp("^0xb6f9de95");
const swapETHForExactTokens = new RegExp("^0xfb3bdb41");
const swapExactETHForTokens = new RegExp("^0x7ff36ab5");
//确定性买入匹配数组
const pcsBuyList = [
    swapExactETHForTokens,
    swapExactETHForTokensSupportingFeeOnTransferTokens,
    swapETHForExactTokens
]

class ListNode {
    constructor(hash) {
        this.hash = hash;
        this.prev = null;
        this.next = null;
    }
}

class HashQueue {
    constructor(limit = 3000) {
        this.limit = limit;
        this.hashSet = new Set();
        this.head = null; // 双向链表的头
        this.tail = null; // 双向链表的尾
        this.size = 0;    // 当前链表大小
    }

    add(hash) {
        if (this.hashSet.has(hash)) {
            return; // 已存在，直接返回
        }

        const newNode = new ListNode(hash);
        this.hashSet.add(hash);

        // 如果链表为空
        if (!this.head) {
            this.head = newNode;
            this.tail = newNode;
        } else { // 否则，添加到链表的尾部
            newNode.prev = this.tail;
            this.tail.next = newNode;
            this.tail = newNode;
        }

        this.size++;

        if (this.size > this.limit) {
            // 从HashSet中移除头部的hash
            this.hashSet.delete(this.head.hash);

            // 移动链表的头部指针
            this.head = this.head.next;
            if (this.head) {
                this.head.prev = null;
            }

            this.size--;
        }
    }

    has(hash) {
        return this.hashSet.has(hash);
    }
}

const hashQ = new HashQueue(3000);

function exitGracefully() {
    process.kill(process.pid, "SIGTERM");
}


const startWSSpink = () => {
    //全局捕获错误
    process.on('unhandledRejection', error => {
        if (error.message.indexOf("data out-of-bounds") == -1 && error.message.indexOf("overflow") == -1 && error.message.indexOf("toLowerCase") == -1) {
            console.log("-------------------------其他错误-------------------------", error);
            if (error.message.includes("reconnect before the response got received")) {
                console.log("网络波动，停止买入")
                persistStopBuy("网络超负荷，系统无法工作");
                exitGracefully();
            }
        }
    });

    async function pendingSubscription() {
        const subscription = await web3.eth.subscribe('pendingTransactions');
        subscription.on('connect', async () => {
            console.log("Scanning mempool...");
        })
        // note that in version 4.x the way you get notified for `data` and `error` has changed
        subscription.on('data', async (txHash) => {
            hashQ.add(txHash)
            checkTransaction(txHash, false);
        });
        subscription.on('error', (err) => {
            console.log(err);
        });
    }

    async function confirmedSubscription() {
        const subscription = await web3.eth.subscribe('newBlockHeaders');
        subscription.on('connect', async () => {
            console.log("Meanwhile listening for new blocks...");
        })
        // note that in version 4.x the way you get notified for `data` and `error` has changed
        subscription.on('data', async (blockHeader) => {
            processBlock(blockHeader.number);
        });
        subscription.on('error', (err) => {
            console.log(err);
        });
    }

    confirmedSubscription();
    pendingSubscription();

};

function processBlock(blockNumber) {
    web3.eth.getBlock(blockNumber, true).then((block) => {

        for (const tx of block.transactions) {
            if (!hashQ.has(tx.hash)) {
                // 处理不在HashQueue中的交易
                checkTransaction(tx.hash, true);
            }
        }

    }).catch((err) => {
        if (err instanceof TypeError) {
            return
        }
        console.error(`Error processing block #${blockNumber}:`, err);
    });
}





//checkTransaction
const checkTransaction = async (txHash, isTxConfirmed) => {
    let tx;
    try {
        tx = await web3.eth.getTransaction(txHash);
    }
    catch (error) {
        if (error.name == 'TransactionNotFound') {
            return;
        } else {
            throw error;
        }
    }
    const txFrom = tx.from.toLowerCase();
    const txTo = tx.to.toLowerCase();
    const targetBuyBnb = ethers.formatEther(tx.value.toString());
    const inputData = tx.input;
    if (txTo == pcs) {
        //大佬555买入
        if (pcsBuyList.some(regex => regex.test(inputData))) {
            const decodedInput = pcsBuyAbi.parseTransaction({
                data: inputData
            });
            const liquidity = decodedInput.args[1][decodedInput.args[1].length - 2].toLowerCase();
            const targetTokenAddress = decodedInput.args[1][decodedInput.args[1].length - 1].toLowerCase();
            // simulate high concurrency
            checkSingleTokenIsSafe(targetTokenAddress)
            checkSingleTokenIsSafe(targetTokenAddress)
            checkSingleTokenIsSafe(targetTokenAddress)
            checkSingleTokenIsSafe(targetTokenAddress)
            checkSingleTokenIsSafe(targetTokenAddress)
            checkSingleTokenIsSafe(targetTokenAddress)
            checkSingleTokenIsSafe(targetTokenAddress)
            checkSingleTokenIsSafe(targetTokenAddress)
            checkSingleTokenIsSafe(targetTokenAddress)
            checkSingleTokenIsSafe(targetTokenAddress)
            checkSingleTokenIsSafe(targetTokenAddress)
            checkSingleTokenIsSafe(targetTokenAddress)

        }
    }
}



//检测单独代币(没监控到创建的代币或者当前未开源的代币)是否安全
const checkSingleTokenIsSafe = async (tokenAddress) => {
    try {
        const owner = await new Contract(standardTokenAbi, tokenAddress, web3).methods.owner().call();
    } catch (error) {
        // console.log("error in checkSingleTokenIsSafe", error.message)
    }

};




// 在console.log() 前面增加时间输出，中国时区，24小时制
let log = console.log;
console.log = function () {
    let args = Array.from(arguments);
    let log_prefix = new Date().toLocaleTimeString('zh', { timeZone: 'Asia/Shanghai', hour12: false });
    args.unshift(log_prefix + "");
    log.apply(console, args);
}


const startmenu = async () => {
    clear();
    let menu = '1';

    if (menu == '1') {
        clear();
        console.log('pancake gendan starting');
        startWSSpink();
    }
};

//启动主任务
startmenu();