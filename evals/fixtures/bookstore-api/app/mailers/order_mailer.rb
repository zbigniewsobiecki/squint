class OrderMailer < ApplicationMailer
  def confirmation(order)
    @order = order
    @user = order.user
    @items = order.order_items.includes(:book)

    mail(
      to: @user.email,
      subject: "Order ##{order.id} confirmed"
    )
  end

  def cancellation(order)
    @order = order
    @user = order.user

    mail(
      to: @user.email,
      subject: "Order ##{order.id} cancelled"
    )
  end
end
