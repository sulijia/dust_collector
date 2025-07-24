// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

struct PermitParams {
    uint256 value;
    uint256 deadline;
    uint8 v;
    bytes32 r;
    bytes32 s;
}

interface IMayanForwarder2 {
	function forwardERC20(
		address tokenIn,
		uint256 amountIn,
		PermitParams calldata permitParams,
		address mayanProtocol,
		bytes calldata protocolData
	) external payable ;
}

contract DustCollectorUniversalPermit2Mayan is Ownable {
    using SafeERC20 for IERC20;

    IUniversalRouter public immutable router;
    IPermit2 public immutable permit2;
    IMayanForwarder2 public immutable mayan;

    address public feeCollector;
    uint256 public feeBps = 30;

    struct SwapParams {
        bytes commands;
        bytes[] inputs;
        uint256 deadline;
        address targetToken;
        uint16 dstChain;
        bytes32 recipient;
        PermitParams permitParams;
        address mayanProtocol;
        bytes protocolData;
        uint256 estimatedCost;
    }

    event FeeCollected(address indexed token, uint256 amount);
    event Swapped(address indexed user, address indexed token, uint256 amount);
    event Bridged(address indexed user, address indexed token, uint256 amount, uint16 dstChain, bytes32 recipient);

    constructor(address _router, address _permit2, address _mayan, address _feeCollector) Ownable(msg.sender) {
        require(_router != address(0) && _permit2 != address(0) && _mayan != address(0) && _feeCollector != address(0), "zero addr");
        router = IUniversalRouter(_router);
        permit2 = IPermit2(_permit2);
        mayan = IMayanForwarder2(_mayan);
        feeCollector = _feeCollector;
    }

    function setFee(uint256 _bps, address _collector) external onlyOwner {
        require(_bps <= 1000, "too high");
        feeBps = _bps;
        feeCollector = _collector;
    }

    function batchCollectWithUniversalRouter(
        SwapParams calldata params,
        address[] calldata pullTokens,
        uint256[] calldata pullAmounts
    ) external payable {
        require(params.targetToken != address(0), "no target");
        require(pullTokens.length == pullAmounts.length, "len mismatch");

        _pullAndForward(pullTokens, pullAmounts);
        uint256 received = _executeSwap(params);
        _handleResult(params, received);
    }

    function _pullAndForward(address[] calldata tokens, uint256[] calldata amounts) internal {
        for (uint256 i; i < tokens.length; ++i) {
            permit2.transferFrom(msg.sender, address(this), uint160(amounts[i]), tokens[i]);
            IERC20(tokens[i]).safeTransfer(address(router), amounts[i]);
        }
    }

    function _executeSwap(SwapParams calldata p) internal returns (uint256) {
        uint256 beforeBal = IERC20(p.targetToken).balanceOf(address(this));
        require(msg.value >= p.estimatedCost, "Insufficient eth funds.");
        uint256 routerEth = msg.value - p.estimatedCost;
        router.execute{value: routerEth}(p.commands, p.inputs, p.deadline);
        uint256 afterBal = IERC20(p.targetToken).balanceOf(address(this));
        require(afterBal > beforeBal, "no output");
        return afterBal - beforeBal;
    }

    function _handleResult(SwapParams calldata p, uint256 received) internal {
        uint256 feeAmt = received * feeBps / 10_000;
        uint256 userAmt = received - feeAmt;

        if (feeAmt > 0) {
            IERC20(p.targetToken).safeTransfer(feeCollector, feeAmt);
            emit FeeCollected(p.targetToken, feeAmt);
        }

        if (p.dstChain == 0) {
            // 本地操作
            address localRecipient = (p.recipient == bytes32(0)) ? msg.sender : address(uint160(uint256(p.recipient)));
            IERC20(p.targetToken).safeTransfer(localRecipient, userAmt);
            emit Swapped(msg.sender, p.targetToken, userAmt);
        } else {
            // 跨链操作
            _bridgeWithMayan(p, userAmt);
        }
    }

    function _bridgeWithMayan(SwapParams calldata p, uint256 amount) internal {
        IERC20 token = IERC20(p.targetToken);
        token.safeIncreaseAllowance(address(mayan), amount);

        mayan.forwardERC20{value: p.estimatedCost}(
            p.targetToken,
            amount,
            p.permitParams,
            p.mayanProtocol,
            p.protocolData
        );

        token.approve(address(mayan), 0);
        emit Bridged(msg.sender, p.targetToken, amount, p.dstChain, p.recipient);
    }

    function rescueERC20(address t, address to, uint256 amt) external onlyOwner {
        IERC20(t).safeTransfer(to, amt);
    }

    function rescueETH(address payable to, uint256 amt) external onlyOwner {
        require(to != address(0), "zero addr");
        require(amt <= address(this).balance, "insufficient balance");
        (bool success, ) = to.call{value: amt}("");
        require(success, "ETH transfer failed");
    }

    receive() external payable {}
}
