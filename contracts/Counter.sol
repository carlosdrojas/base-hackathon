// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract Counter {
    uint256 public count;

    event CountChanged(uint256 newCount);

    function increment() external {
        count += 1;
        emit CountChanged(count);
    }

    function decrement() external {
        require(count > 0, "Counter: cannot go below zero");
        count -= 1;
        emit CountChanged(count);
    }
}
