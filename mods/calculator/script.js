/**
 * script.js — 计算器插件逻辑
 * 纯 document.querySelector 交互，无外部 import。
 */

let display = document.querySelector('.display .result');
let currentInput = '0';
let operator = '';
let previousInput = '';
let waitingForOperand = false;

function updateDisplay() {
    display.textContent = currentInput;
}

function inputDigit(digit) {
    if (waitingForOperand) {
        currentInput = digit;
        waitingForOperand = false;
    } else {
        currentInput = currentInput === '0' ? digit : currentInput + digit;
    }
    updateDisplay();
}

function inputDecimal() {
    if (waitingForOperand) {
        currentInput = '0.';
        waitingForOperand = false;
    } else if (!currentInput.includes('.')) {
        currentInput += '.';
    }
    updateDisplay();
}

function clear() {
    currentInput = '0';
    operator = '';
    previousInput = '';
    waitingForOperand = false;
    updateDisplay();
}

function performOperation(nextOperator) {
    const inputValue = parseFloat(currentInput);

    if (previousInput === '') {
        previousInput = inputValue;
    } else if (operator) {
        inputValue = calculate(previousInput, inputValue, operator);
        currentInput = String(inputValue);
        previousInput = inputValue;
    }

    waitingForOperand = true;
    operator = nextOperator;
    updateDisplay();
}

function calculate(firstValue, secondValue, operation) {
    switch (operation) {
        case '+':
            return firstValue + secondValue;
        case '-':
            return firstValue - secondValue;
        case '×':
            return firstValue * secondValue;
        case '÷':
            return firstValue / secondValue;
        case '%':
            return firstValue % secondValue;
        default:
            return secondValue;
    }
}

function performEquals() {
    if (previousInput === '' || !operator) return;
    const newValue = calculate(parseFloat(previousInput), parseFloat(currentInput), operator);
    currentInput = String(newValue);
    previousInput = '';
    operator = '';
    waitingForOperand = true;
    updateDisplay();
}

function toggleSign() {
    currentInput = String(-parseFloat(currentInput));
    updateDisplay();
}

function percent() {
    currentInput = String(parseFloat(currentInput) / 100);
    updateDisplay();
}

[
    ['.clear', clear], ['.plus-minus', toggleSign], ['.percent', percent],
    ['.divide', () => performOperation('÷')], ['.multiply', () => performOperation('×')],
    ['.subtract', () => performOperation('-')], ['.add', () => performOperation('+')],
    ['.equals', performEquals], ['.decimal', inputDecimal],
    ['.seven', () => inputDigit('7')], ['.eight', () => inputDigit('8')], ['.nine', () => inputDigit('9')],
    ['.four', () => inputDigit('4')], ['.five', () => inputDigit('5')], ['.six', () => inputDigit('6')],
    ['.one', () => inputDigit('1')], ['.two', () => inputDigit('2')], ['.three', () => inputDigit('3')],
    ['.zero', () => inputDigit('0')],
].forEach(([sel, fn]) => document.querySelector(sel).addEventListener('click', fn));